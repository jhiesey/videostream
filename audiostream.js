var inherits = require('inherits');
var toArrayBuffer = require('to-arraybuffer');
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

    self._buffer = null;
    self._playOffset = 0;
    self._pauseOffset = 0;
    self._hasAudio = true;
    self._elem = mediaElem;
    self._visualiser = null;
    self._audioSource = null;
    self._audioBuffer = null;
    self._videoStream = null;
    self._audioStream = null;
    self._outputStream = null;
    self._videoContext = null;
    self._audioContext = context;
    self._audioAnalyser = null;

    var fileStream = file.createReadStream({start: 0});
    self._fileStream = fileStream;

    fileStream.on('data', function(data) {
        var buffer = self._buffer;
        self._buffer = buffer ? Buffer.concat([buffer, data]) : data;
    });

    fileStream.on('end', function() {
        var buffer = toArrayBuffer(self._buffer);

        fileStream.destroy();
        context.decodeAudioData(buffer.slice(0), function(buffer) {
            try {
                self._setup(buffer, opts.autoplay);
            }
            catch (ex) {
                log(ex);
                self.destroy(ex);
            }
        });
        self.emit('audio-buffer', buffer);
    });

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
}

inherits(AudioStream, EventEmitter);

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
            audioStream.disconnect();
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

AudioStream.prototype._setup = function(buffer, autoplay) {
    var self = this;
    var elm = self._elem;
    var audioContext = self._audioContext;
    var audioStream = audioContext.createMediaStreamDestination();
    var videoContext = document.createElement('canvas');
    var videoStream = videoContext.captureStream(30);
    var tracks = [audioStream.stream.getTracks()[0], videoStream.getTracks()[0]];
    var audioAnalyser = audioContext.createAnalyser();

    // log('setup', buffer, autoplay, tracks);

    audioStream.connect(audioContext.destination);

    self._visualiser = new Visualiser(self);
    self._audioAnalyser = audioAnalyser;
    self._videoContext = videoContext;
    self._videoStream = videoStream;
    self._audioStream = audioStream;
    self._audioBuffer = buffer;
    self._play(0);

    if (!autoplay) {
        self._onPause();
        self._pauseOffset += .001;
    }

    elm.srcObject = new MediaStream(tracks);
    // elm.srcObject = self._audioStream.stream;

    Object.defineProperty(elm, 'duration', {
        writable: true,
        enumerable: true,
        configurable: true,
        value: buffer.duration
    });
};

AudioStream.prototype._stop = function() {
    var self = this;
    var audioSource = self._audioSource;
    var visualiser = self._visualiser;

    if (audioSource) {
        audioSource.disconnect();
        audioSource.stop(0);
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
};

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
            self._elem.pause();
        }

        return result;
    }
});

function AudioVisualiser(stream, fftSize) {
    var self = this;
    var videoElement = stream._elem;

    self._tick = 0;
    self._image = null;
    self._stream = stream;
    self._fftSize = fftSize || 0x4000;

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
            self._draw();
        }, 50);
    };
    window.addEventListener('resize', self._onResize);
}

inherits(AudioVisualiser, null);

AudioVisualiser.prototype.destroy = function() {
    var self = this;

    if (!self.destroyed) {
        self.destroyed = true;
        self._tick = null;
        window.removeEventListener('resize', self._onResize);
    }
};

AudioVisualiser.prototype._start = function() {
    this._draw();
};

AudioVisualiser.prototype._stop = function() {
    this._tick = -1;
};

AudioVisualiser.prototype._draw = function() {
    var self = this;
    var tick = ++self._tick;
    var stream = self._stream;
    var videoElement = stream._elem;
    var canvas = stream._videoContext;
    var analiser = stream._audioAnalyser;
    var $video = $(videoElement).parent();

    canvas.width = $video.outerWidth() + 16 & -16;
    canvas.height = $video.outerHeight() + 16 & -16;

    var ctx = canvas.getContext('2d');

    self.init(ctx, canvas.width, canvas.height, canvas);

    // log('draw', canvas.width, canvas.height, self);

    analiser.fftSize = self._fftSize;

    (function _draw() {
        if (tick === self._tick) {
            requestAnimationFrame(_draw);
            var data = new Uint8Array(analiser.frequencyBinCount);
            analiser.getByteFrequencyData(data);
            self.draw(data, ctx, canvas.width, canvas.height, canvas);
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

    var i = width / 24, x, y, s, stars = [];
    while (i-- > 0) {
        x = (Math.random() - 0.5) * width;
        y = (Math.random() - 0.5) * height;
        s = (Math.random() + 0.1) * 3;
        stars.push(new Star(x, y, s, ctx, width, height, this));
    }
    this.stars = stars;
};

Visualiser.prototype.draw = function(data, ctx, width, height, canvas) {
    var value, grd, vol = 0, r, g, b, i = data.byteLength;

    for (r = 0; r < 80; r++) vol += data[r];
    this.volume = vol;

    value = vol / 1000;
    r = 0x1f + (Math.sin(value) + 1);
    g = r;//value * 2;
    b = r;//value * 8;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    ctx.rect(0, 0, width, height);

    grd = ctx.createRadialGradient(width / 2, height / 2, value / 1.4, width / 2, height / 2, width - Math.min(Math.pow(value / 1.4, 2.7), width - 20));
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.8, "rgba(" + Math.round(r) + ", " + Math.round(g) + ", " + Math.round(b) + ", 0.4)");

    ctx.fillStyle = grd;
    ctx.fill();
    ctx.closePath();

    ctx.beginPath();
    ctx.fillStyle = this.gradient;

    while (i--) {
        value = data[i] / 1.4;
        ctx.fillRect(i * 5, (height - value) / 1.2, 4, value / 1.3);
    }
    ctx.closePath();

    var analyser = this._stream._audioAnalyser;
    data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(217, 0, 7, 0.8)';

    ctx.moveTo(0, height - data[0]);
    i = data.byteLength;
    while (i--) {
        ctx.lineTo(i, height - data[i]);
    }
    ctx.stroke();
    ctx.closePath();

    ctx.beginPath();
    ctx.translate(width / 2, height / 2);

    for (r = this.stars.length; r--;) {
        this.stars[r].drawStar();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
