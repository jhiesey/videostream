'use strict';

var pump = require('pump');
var MP4Remuxer = require('./mp4-remuxer');
var MediaElementWrapper = require('mediasource');
var toArrayBuffer = require('to-arraybuffer');

module.exports = VideoStream;

function VideoStream(file, mediaElem, opts) {
    var self = this;
    if (!(this instanceof VideoStream)) {
        return new VideoStream(file, mediaElem, opts)
    }
    opts = opts || {};

    self.detailedError = null;

    self._elem = mediaElem;
    self._elemWrapper = new MediaElementWrapper(mediaElem, opts);
    self._waitingFired = false;
    self._trackMeta = null;
    self._file = file;
    self._tracks = null;
    if (self._elem.preload !== 'none') {
        self._createMuxer()
    }
    if (!opts.sbflush) {
        self.flushSourceBuffers = function() {
            /* noop */
        };
    }

    self._onError = function(err) {
        self.detailedError = self._elemWrapper.detailedError || err;
        if (d) {
            console.error('VideoStream Error.', err, self.detailedError);
        }
        self.destroy() // don't pass err though so the user doesn't need to listen for errors
    };
    self._onWaiting = function() {
        self._waitingFired = true;
        if (!self._muxer) {
            self._createMuxer()
        }
        else if (self._tracks) {
            self._pump()
        }
    };
    self._elem.addEventListener('waiting', self._onWaiting);
    self._elem.addEventListener('error', self._onError)
}

VideoStream.prototype = Object.create(null);

VideoStream.prototype._createMuxer = function() {
    var self = this;
    self._muxer = new MP4Remuxer(self._file);
    self._muxer.on('ready', function(data) {
        self._tracks = data.map(function(trackData) {
            var mediaSource = self.createWriteStream(trackData.mime);
            var track = {
                muxed: null,
                mediaSource: mediaSource,
                initFlushed: false,
                onInitFlushed: null
            };
            mediaSource.write(trackData.init, function(err) {
                track.initFlushed = true;
                if (track.onInitFlushed) {
                    track.onInitFlushed(err)
                }
            });
            return track
        });

        if (self._waitingFired || self._elem.preload === 'auto') {
            self._pump()
        }
    });

    self._muxer.on('error', function(err) {
        self._elemWrapper.error(err)
    })
};

VideoStream.prototype.createWriteStream = function(obj) {
    var videoStream = this;
    var mediaSource = videoStream._elemWrapper.createWriteStream(obj);
    var mediaSourceDestroy = mediaSource.destroy;

    mediaSource._write = function(chunk, encoding, cb) {
        if (!this.destroyed) {
            var self = this;
            var sb = this._sourceBuffer;

            if (sb && !sb.updating) {
                try {
                    sb.appendBuffer(toArrayBuffer(chunk));
                    this._cb = cb;
                    return;
                }
                catch (ex) {
                    if (d > 1) {
                        console.debug('Caught %s', ex.name, ex);
                    }
                    if (ex.name === 'QuotaExceededError') {
                        videoStream.flushSourceBuffers(-1);
                    }
                    else if (ex.name !== 'InvalidStateError') {
                        return self.destroy(ex);
                    }
                }
            }

            // retry later
            this._cb = function(err) {
                if (err) {
                    return cb(err);
                }
                self._write(chunk, encoding, cb);
            };
        }
    };

    mediaSource.destroy = function(err) {
        try {
            mediaSourceDestroy.apply(mediaSource, arguments);
        }
        catch (ex) {
            var self = this;
            var sb = this._sourceBuffer;

            if (d) {
                console.debug('Caught exception ("%s")', ex.name, sb && sb.updating, sb, ex);
            }

            if (sb && sb.updating) {
                // This must have been an InvalidStateError invoking .abort()
                // with pending .remove()s from the seeking event...

                if (err) {
                    self.emit('error', err);
                }
                self.emit('close');
            }
            else {
                throw ex;
            }
        }
    };

    mediaSource.on('error', function(err) {
        videoStream._elemWrapper.error(err)
    });

    return mediaSource;
};

VideoStream.prototype._pump = function() {
    try {
        this._unsafePump();
    }
    catch (ex) {
        this._onError(ex);
    }
};

VideoStream.prototype._unsafePump = function() {
    var self = this;
    var muxed = self._muxer.seek(self._elem.currentTime, !self._tracks);

    self._tracks.forEach(function(track, i) {
        var pumpTrack = function() {
            if (track.muxed) {
                track.muxed.destroy();
                track.mediaSource = self.createWriteStream(track.mediaSource)
            }
            track.muxed = muxed[i];
            pump(track.muxed, track.mediaSource)
        };
        if (!track.initFlushed) {
            track.onInitFlushed = function(err) {
                if (err) {
                    self._elemWrapper.error(err);
                    return
                }
                pumpTrack()
            }
        }
        else {
            pumpTrack()
        }
    })
};

VideoStream.prototype.destroy = function() {
    var self = this;
    if (self.destroyed) {
        return
    }
    self.destroyed = true;

    self._elem.removeEventListener('waiting', self._onWaiting);
    self._elem.removeEventListener('error', self._onError);

    if (self._tracks) {
        var i, track, tracks = self._tracks;

        for (i = tracks.length; i--;) {
            track = tracks[i];

            try {
                if (track.muxed) {
                    track.muxed.destroy();
                }
            }
            catch (ex) {
                console.warn(track, ex);
            }
        }
    }

    if (String(self._elem.src).startsWith('blob:')) {
        URL.revokeObjectURL(self._elem.src);
    }

    self._elem.removeAttribute('src');
    self._elem = false;
};

VideoStream.prototype.forEachSourceBuffer = function(cb) {
    if (this._tracks) {
        var i, currentTime = this._elem.currentTime, sb, startRange, endRange, ms;

        for (i = this._tracks.length; i--;) {
            ms = this._tracks[i].mediaSource._mediaSource;
            sb = this._tracks[i].mediaSource._sourceBuffer;

            try {
                startRange = sb.buffered.length ? sb.buffered.start(0) : 0;
                endRange = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;

                cb.call(this, sb, startRange, endRange, currentTime, ms);
            }
            catch (ex) {
                console.debug(ex);
            }
        }
    }
};

// Flush source buffers when seeking backward or forward
VideoStream.prototype.flushSourceBuffers = function(mode) {
    this.forEachSourceBuffer(function(sb, startRange, endRange, currentTime, mediaSource) {
        if (d) {
            console.debug('[VideoStream.flushSourceBuffers] ct=%s sr=%s er=%s',
                currentTime, startRange, endRange, sb.updating, mediaSource.readyState, mode, sb);
        }

        if (!sb.updating /*&& mediaSource.readyState === 'ended'*/) {

            if (mode !== -1) {
                if (endRange > currentTime) {
                    startRange = Math.max(currentTime + 1, startRange);
                }
                else if (currentTime >= startRange && currentTime <= endRange) {
                    endRange = currentTime - 1;
                }
            }
            else {
                if (endRange >= currentTime) {
                    endRange = Math.floor(currentTime);
                }
                if (startRange >= currentTime) {
                    return;
                }
            }

            if (endRange > startRange && (endRange - startRange) > 1) {
                sb.remove(startRange, endRange);

                if (d) {
                    console.log('[VideoStream.flushSourceBuffers] remove took place', startRange, endRange);
                }
            }
        }
    });
};

// Returns the number of buffered seconds
Object.defineProperty(VideoStream.prototype, 'bufTime', {
    get: function() {
        var trak = this._muxer._tracks[0] || false;
        var smpl = trak && trak.samples[trak.currSample] || false;
        var time = (smpl.dts + smpl.duration) / trak.timeScale;

        if (0) {
            var result = time - this._elem.currentTime;

            if (d) {
                var trakBufTimes = [];

                for (var i = Object(this._tracks).length; i--;) {
                    var mediaSourceStream = this._tracks[i].mediaSource;

                    trakBufTimes[i] = mediaSourceStream._getBufferDuration()
                        + '@' + mediaSourceStream._mediaSource.readyState;
                }

                console.warn('bufTime=%s, MediaSource: ', result, trakBufTimes.join(','));
            }

            return result;
        }
        else {
            return time - this._elem.currentTime;
        }
    }
});
