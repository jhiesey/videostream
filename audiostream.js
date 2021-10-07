var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;
var Buffer = require('buffer').Buffer;

module.exports = AudioStream;

var log = console.warn.bind(console, 'audiostream');

function AudioStream(file, mediaElem, opts) {
    var self = this;

    if (!(this instanceof AudioStream)) {
        return new AudioStream(file, mediaElem, opts)
    }
    EventEmitter.call(self);

    var context = new AudioContext();
    var destroy = function(ex) {
        log(ex);
        self.destroy(ex);
    };

    self._file = file;
    self._decTick = 0;
    self._buffer = null;
    self._bytesRead = 0;
    self._playOffset = 0;
    self._pauseOffset = 0;
    self._hasAudio = true;
    self._decoding = false;
    self._complete = false;
    self._elem = mediaElem;
    self._visualiser = null;
    self._audioSource = null;
    self._audioBuffer = null;
    self._videoStream = null;
    self._audioStream = null;
    self._outputStream = null;
    self._videoCanvas = null;
    self._videoContext = null;
    self._audioContext = context;
    self._audioAnalyser = null;

    var fileStream = file.createReadStream({start: 0});
    self._fileStream = fileStream;

    fileStream.on('data', tryCatch(function(data) {
        if (self._bytesRead > 0) {
            self._buffer.set(data, self._bytesRead);
            self._bytesRead += data.byteLength;
        }
        else if (self._buffer) {
            var tmp = new Uint8Array(data.byteLength + self._buffer.byteLength);
            tmp.set(self._buffer);
            tmp.set(data, self._buffer.byteLength);
            self._buffer = tmp;
        }
        else if (file.filesize > 0) {
            self._buffer = new Uint8Array(file.filesize);
            self._buffer.set(data, self._bytesRead);
            self._bytesRead += data.byteLength;
        }
        else {
            self._buffer = data;
        }

        if (opts.partial) {
            self._feed(opts);

            var read = self._bytesRead || self._buffer.byteLength;
            var size = Math.min(file.fetchChunkSize << 1, AudioStream.maxChunkSize);

            if (read > size) {
                file.fetchChunkSize = size;
                file.readerChunkSize = size;
            }
        }
    }, destroy));

    fileStream.on('end', tryCatch(function() {
        fileStream.destroy();
        fileStream._file.reset();

        self._complete = true;
        self._feed(opts);

    }, destroy));

    self._onError = function(err) {
        self.destroy(err);
    };
    self._onPause = function() {
        if (self._audioStream) {
            var offset = context.currentTime - self._playOffset;
            self._stop();
            self._pauseOffset = offset;
            // log('onpause', offset);
        }
    };
    self._onPlay = function() {
        // log('onplay', self._pauseOffset);

        if (self._audioStream && self._pauseOffset) {
            var audioBuffer = self._audioBuffer || false;
            self._play(self._pauseOffset >= audioBuffer.duration ? 0 : self._pauseOffset);
        }
    };
    mediaElem.addEventListener('play', self._onPlay);
    mediaElem.addEventListener('pause', self._onPause);
    mediaElem.addEventListener('error', self._onError);

    if (context.state === 'suspended') {
        onIdle(function() {
            context.resume();
        });
    }
}

inherits(AudioStream, EventEmitter);

Object.defineProperty(AudioStream, 'maxChunkSize', {value: 4194304});
Object.defineProperty(AudioStream, 'partialChunkSize', {value: 262144});

Object.defineProperty(AudioStream.prototype, 'ready', {
    get: function() {
        return this._complete && !this._decoding;
    }
});

AudioStream.prototype.destroy = function(err) {
    var self = this;

    if (!self.destroyed) {
        var elm = self._elem;

        self.destroyed = true;
        self._buffer = null;
        self._fileStream.destroy();

        elm.removeEventListener('play', self._onPlay);
        elm.removeEventListener('pause', self._onPause);
        elm.removeEventListener('error', self._onError);
        elm.removeAttribute('src');
        elm.srcObject = null;
        self._stop();

        var audioStream = self._audioStream;
        if (audioStream) {
            try {
                audioStream.disconnect();
            }
            catch (ex) {}
        }

        var visualiser = self._visualiser;
        if (visualiser) {
            visualiser.destroy();
        }

        var audioContext = self._audioContext;
        if (audioContext) {
            audioContext.close();
        }

        self.emit('close');
        if (err) {
            self.emit('error', err);
        }
    }
};

AudioStream.prototype._decode = function(opts) {
    var self = this;

    if (self._buffer && !self._decoding) {
        var len, data = self._buffer, done = !!self._complete;

        if (done) {
            data = data.buffer;
            self.emit('audio-buffer', data);
            self._buffer = null;
        }
        else {
            var bufTime = this._bufTime;
            if (bufTime > 20) {
                self._decoding = true;
                // log('bufTime', bufTime);
                delay('vs.decode-audio-holder', function() {
                    self._decoding = false;
                    self._decode(opts);
                }, 2e3);
                return;
            }
            data = data.buffer.slice(0, self._bytesRead || undefined);
        }
        len = data.byteLength;

        if (d > 1) {
            log('Decoding new chunk...', done, len);
        }

        self._decoding = true;
        self._audioContext.decodeAudioData(data)
            .then(function(buffer) {
                if (done || !opts.startTime || buffer.duration > opts.startTime) {
                    self._setup(opts.autoplay, opts.startTime, buffer);
                }
            })
            .catch(function(ex) {
                if (d && done || d > 1) {
                    log(ex);
                }
                if (done) {
                    self.destroy(ex);
                }
                self._decTick = 1e11;
            })
            .finally(function() {
                self._decoding = false;
                var again = !done && self._complete;
                if (!again && self._buffer) {
                    var c = self._buffer;
                    var b = self._bytesRead;
                    var r = b > 0 ? Math.min(b, c.byteLength) : c.byteLength;
                    again = r !== len;
                }
                if (again) {
                    self._decode(opts);
                }
            });
    }
};

AudioStream.prototype._feed = function(opts) {
    var self = this;

    if (!self._decoding) {
        return self._decode(opts);
    }

    delay('vs.decode-audio-data', function() {
        self._decTick = 0;
        self._decode(opts);
    }, self._complete || ++self._decTick > 31 ? 90 : 4e3);
};

AudioStream.prototype._setup = function(autoplay, time, buffer) {
    var self = this;
    var elm = self._elem;

    if (self.destroyed) {
        log('This instance has been destroyed.', [this]);
        return;
    }

    Object.defineProperty(elm, 'duration', {
        writable: true,
        enumerable: true,
        configurable: true,
        value: buffer.duration
    });

    if (self._audioBuffer) {
        time = self.currentTime;
        if (d > 1) {
            log('new chunk arrived...', [buffer], buffer.duration, time);
        }
        self._audioBuffer = buffer;
        self._play(time);
        self.emit('duration', buffer.duration);
        return;
    }

    var audioContext = self._audioContext;
    var audioStream = audioContext.createMediaStreamDestination();
    var videoCanvas = document.createElement('canvas');
    var videoContext = videoCanvas.getContext('2d');
    var videoStream = self._captureStream(videoCanvas);
    var tracks = [audioStream.stream.getTracks()[0], videoStream.getTracks()[0]];
    var audioAnalyser = audioContext.createAnalyser();

    if (d > 1) {
        log('setup', buffer, autoplay, tracks);
    }

    self._visualiser = new Visualiser(self);
    self._audioAnalyser = audioAnalyser;
    self._videoCanvas = videoCanvas;
    self._videoContext = videoContext;
    self._videoStream = videoStream;
    self._audioStream = audioStream;
    self._audioBuffer = buffer;

    if (audioStream.numberOfOutputs > 0) {
        // legacy Web Audio API support.
        self._audioStream = audioContext.destination;
    }
    self._play(time | 0);

    if (!autoplay) {
        self._onPause();
        self._pauseOffset += .001;
    }

    elm.srcObject = new MediaStream(tracks);
    // elm.srcObject = self._audioStream.stream;
};

AudioStream.prototype._stop = function() {
    var self = this;
    var audioSource = self._audioSource;
    var visualiser = self._visualiser;

    if (audioSource) {
        try {
            audioSource.disconnect();
            audioSource.stop(0);
        }
        catch (ex) {}
    }

    if (visualiser) {
        visualiser._stop();
    }

    self._playOffset = 0;
    self._pauseOffset = 0;
};

AudioStream.prototype._play = function(time) {
    var self = this;
    var context = self._audioContext;
    var visualiser = self._visualiser;
    var audioBuffer = self._audioBuffer;
    var source = context.createBufferSource();

    // log('play', time, audioSource, context);

    if (!audioBuffer) {
        log('Cannot play, audio buffer not yet ready.');
        return;
    }
    this._stop();

    source.buffer = audioBuffer;
    source.connect(self._audioAnalyser);
    source.connect(self._audioStream);
    source.start(0, time);
    source.playbackRate.setValueAtTime(1, time);

    self._audioSource = source;
    self._playOffset = self._audioContext.currentTime - time;
    self._pauseOffset = 0;

    if (visualiser) {
        visualiser._start();
    }

    var f = self._file;
    f.paused = false;
    f.playing = true;
    self.emit('activity');
};

AudioStream.prototype._captureStream = function(canvas) {
    var stream;

    try {
        var t = window.CanvasCaptureMediaStreamTrack;
        if (t && typeof t.prototype.requestFrame === 'function') {
            var tmp = canvas.captureStream(0);
            var track = tmp.getTracks()[0];

            track.requestFrame();
            this.requestFrame = function() {
                track.requestFrame();
            };
            stream = tmp;
        }
    }
    catch (ex) {
        log(ex);
    }

    if (!stream) {
        log('This browser does lack CanvasCaptureMediaStreamTrack.requestFrame');
        stream = canvas.captureStream(24);
    }

    return stream;
};

Object.defineProperty(AudioStream.prototype, '_bufTime', {
    get: function() {
        var ab = this._audioBuffer || false;
        return ab.duration - this.currentTime;
    }
});

Object.defineProperty(AudioStream.prototype, 'currentTime', {
    get: function() {
        var self = this;
        var audioBuffer = self._audioBuffer || false;

        if (self._pauseOffset) {
            return self._pauseOffset;
        }

        var context = self._audioContext;
        var result = 0;

        if (self._playOffset) {
            result = context.currentTime - self._playOffset;
        }
        // log('currentTime', result, context.currentTime, self._playOffset);

        if (result >= audioBuffer.duration) {
            if (self.ready) {
                self._elem.pause();
            }
            else {
                self._onPause();
                self.emit('inactivity');
                var f = self._file;
                f.paused = true;
                f.playing = false;
            }
        }

        return result;
    }
});

function AudioVisualiser(stream, fftSize) {
    var self = this;
    var videoElement = stream._elem;

    self._tick = 0;
    self._image = null;
    self._barWidth = 4;
    self._byteData = null;
    self._stream = stream;
    self._fftSize = fftSize || 0x1000;
    self._hasFocus = document.hasFocus();

    /*if (videoElement.poster) {
        var img = new Image();
        img.onload = function() {
            self._image = this;
        };
        img.src = videoElement.poster;
        img = undefined;
    }*/

    var timer = null;
    self._onResize = function() {
        clearTimeout(timer);
        timer = setTimeout(function() {
            self._start();
        }, 50);
    };
    window.addEventListener('resize', self._onResize);

    window.addEventListener('focus', self._onFocus = function() {
        self._hasFocus = true;
    });

    window.addEventListener('blur', self._onBlur = function() {
        self._hasFocus = false;
    });
}

inherits(AudioVisualiser, null);

AudioVisualiser.prototype.destroy = function() {
    var self = this;

    if (!self.destroyed) {
        self.destroyed = true;
        window.removeEventListener('blur', self._onBlur);
        window.removeEventListener('focus', self._onFocus);
        window.removeEventListener('resize', self._onResize);
        self._stop();
    }
};

AudioVisualiser.prototype._start = function() {
    this._stop();
    this._draw();
};

AudioVisualiser.prototype._stop = function() {
    this._tick++;
    this._byteData = false;
};

AudioVisualiser.prototype._draw = function() {
    var self = this;
    var tick = ++self._tick;
    var stream = self._stream;
    var videoElement = stream._elem;
    var ctx = stream._videoContext;
    var canvas = stream._videoCanvas;
    var analyser = stream._audioAnalyser;
    var $video = $(videoElement).parent();

    canvas.width = $video.outerWidth() + 16 & -16;
    canvas.height = $video.outerHeight() + 16 & -16;

    self.init(ctx, canvas.width, canvas.height, canvas);

    // log('draw', canvas.width, canvas.height, self);

    analyser.fftSize = self._fftSize;
    analyser.smoothingTimeConstant = 0.85;

    self._byteData = new Uint8Array(analyser.frequencyBinCount);
    self._barWidth = Math.max(4, (canvas.width / self._byteData.byteLength) * 8);

    (function _draw() {
        if (tick === self._tick) {
            self.draw(ctx, canvas.width, canvas.height);

            if (stream.requestFrame) {
                stream.requestFrame();

                if (self._hasFocus) {
                    setTimeout(_draw, 60);
                }
                else {
                    later(_draw);
                }
            }
            else {
                requestAnimationFrame(_draw);
            }
        }
    })();
};

function Visualiser(stream, fftSize) {
    AudioVisualiser.call(this, stream, fftSize);
    this.stars = [];
    this.volume = 0;
    this.gradient = null;
}

inherits(Visualiser, AudioVisualiser);

Visualiser.prototype.init = function(ctx, width, height, canvas) {
    var _gradient = ctx.createLinearGradient(0, 0, 0, 300);
    _gradient.addColorStop(1.00, 'rgba(96, 96, 98, 0.6)');
    _gradient.addColorStop(0.75, 'rgba(26, 24, 24, 0.8)');
    this.gradient = _gradient;

    /**
    var i = width / 24, x, y, s, stars = [];
    while (i-- > 0) {
        x = (Math.random() - 0.5) * width;
        y = (Math.random() - 0.5) * height;
        s = (Math.random() + 0.1) * 3;
        stars.push(new Star(x, y, s, ctx, width, height, this));
    }
    this.stars = stars;
    /**/
};

Visualiser.prototype.draw = function(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
    if (!this._hasFocus) {
        return;
    }
    var data = this._byteData;
    var stream = this._stream;
    var analyser = stream._audioAnalyser;
    analyser.getByteFrequencyData(data);

    var value, grd, vol = 0, r, g, b, i = data.byteLength;

    for (r = 0; r < 80; r++) vol += data[r];
    this.volume = vol;

    value = vol / 1000;
    r = 0x1f + (Math.sin(value) + 1);
    g = r;//value * 2;
    b = r;//value * 8;

    /**
    ctx.beginPath();
    ctx.rect(0, 0, width, height);

    grd = ctx.createRadialGradient(width / 2, height / 2, value / 1.4, width / 2, height / 2, width - Math.min(Math.pow(value / 1.4, 2.7), width - 20));
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.8, "rgba(" + Math.round(r) + ", " + Math.round(g) + ", " + Math.round(b) + ", 0.4)");

    ctx.fillStyle = grd;
    ctx.fill();
    ctx.closePath();
    /**/

    ctx.beginPath();
    ctx.fillStyle = this.gradient;

    r = this._barWidth;
    while (i--) {
        value = data[i] / 1.4;
        ctx.fillRect(i * (r + 1), (height - value) / 1.2, r, value / 1.3);
    }
    ctx.closePath();

    /**/
    analyser.getByteTimeDomainData(data);

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(217, 0, 7, 0.8)';

    ctx.moveTo(0, height - data[0]);
    i = data.byteLength;
    while (i--) {
        ctx.lineTo(i, height - data[i]);
        // ctx.lineTo(i << 1, height - data[i]);
    }
    ctx.stroke();
    ctx.closePath();
    /**/

    /**
    ctx.beginPath();
    ctx.translate(width / 2, height / 2);

    for (r = this.stars.length; r--;) {
        this.stars[r].drawStar();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    /**/
};

// based on https://github.com/michaelbromley/soundcloud-visualizer
function Star(x, y, starSize, ctx, width, height, parent) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.angle = Math.atan(Math.abs(y) / Math.abs(x));
    this.starSize = starSize;
    this.ctx = ctx;
    this.high = 0;
    this.parent = parent;
}

Star.prototype.drawStar = function() {
    var distanceFromCentre = Math.sqrt(Math.pow(this.x, 2) + Math.pow(this.y, 2));

    // stars as lines
    var brightness = 200 + Math.min(Math.round(this.high * 5), 55);
    this.ctx.lineWidth = 0.5 + distanceFromCentre / 2000 * Math.max(this.starSize / 2, 1);
    this.ctx.strokeStyle = 'rgba(' + brightness + ', ' + brightness + ', ' + brightness + ', 0.8)';
    this.ctx.beginPath();
    this.ctx.moveTo(this.x, this.y);
    var lengthFactor = 1 + Math.min(Math.pow(distanceFromCentre, 2) / 3e4 * Math.pow(this.parent.volume, 2) / 6e6, distanceFromCentre / 16);
    var toX = Math.cos(this.angle) * -lengthFactor;
    var toY = Math.sin(this.angle) * -lengthFactor;
    toX *= this.x > 0 ? 1 : -1;
    toY *= this.y > 0 ? 1 : -1;
    this.ctx.lineTo(this.x + toX, this.y + toY);
    this.ctx.stroke();
    this.ctx.closePath();

    // starfield movement coming towards the camera
    var speed = lengthFactor / 20 * this.starSize;
    this.high -= Math.max(this.high - 0.0001, 0);
    if (speed > this.high) {
        this.high = speed;
    }
    var dX = Math.cos(this.angle) * this.high;
    var dY = Math.sin(this.angle) * this.high;
    this.x += this.x > 0 ? dX : -dX;
    this.y += this.y > 0 ? dY : -dY;

    var limitY = this.height / 2 + 500;
    var limitX = this.width / 2 + 500;
    if ((this.y > limitY || this.y < -limitY) || (this.x > limitX || this.x < -limitX)) {
        // it has gone off the edge so respawn it somewhere near the middle.
        this.x = (Math.random() - 0.5) * this.width / 3;
        this.y = (Math.random() - 0.5) * this.height / 3;
        this.angle = Math.atan(Math.abs(this.y) / Math.abs(this.x));
    }
};


onIdle(function() {
    require('promise-decode-audio-data');
});
