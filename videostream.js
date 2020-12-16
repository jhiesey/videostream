'use strict';

var pump = require('pump');
var MP4Remuxer = require('./mp4-remuxer');
var EBMLRemuxer = require('./ebml-remuxer');
var MediaElementWrapper = require('mediasource');

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
    self._seekCoercion = false;
    self._trackMeta = null;
    self._file = file;
    self._tracks = null;
    self._type = opts.type;
    self._startTime = opts.startTime;
    if (self._elem.preload !== 'none') {
        self._createMuxer()
    }
    self.flushSourceBuffers = opts.sbflush ? self._flushSourceBuffers : function() { /* noop */
    };

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
            /*if (d && self._type === 'WebM' && self._elem.currentTime) {
                self.findTimeGAPs();
            }*/
            self._pump(self._startTime | 0);
            self._startTime = null;
        }
    };

    if (self._elem.autoplay) {
       self._elem.preload = "auto";
    }
    self._elem.addEventListener('waiting', self._onWaiting);
    self._elem.addEventListener('error', self._onError)
}

VideoStream.prototype = Object.create(null);

VideoStream.prototype._createMuxer = function() {
    var self = this;
    var ebml = {'WebM': 1, 'Matroska': 1};
    self._muxer = ebml[self._type] ? new EBMLRemuxer(self._file) : new MP4Remuxer(self._file);
    self._muxer.once('ready', function(data) {
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
            self._pump(self._startTime | 0);
            self._startTime = null;
        }
    });

    self._muxer.on('error', function(err) {
        self._elemWrapper.error(err)
    })
};

VideoStream.prototype.createWriteStream = function(obj) {
    var videoStream = this;
    var videoFile = videoStream._file;
    var mediaSource = videoStream._elemWrapper.createWriteStream(obj);
    var mediaSourceDestroy = mediaSource.destroy;

    mediaSource._write = function(chunk, encoding, cb) {
        if (!this.destroyed) {
            var self = this;
            var sb = this._sourceBuffer;

            if (sb && !sb.updating) {
                try {
                    /**
                    if (d > 6) {
                        if (!sb._mimeType) {
                            sb._mimeType = mediaSource._type;

                            sb.addEventListener('abort', console.warn.bind(console));
                            sb.addEventListener('error', console.warn.bind(console));
                        }
                        console.warn('Appending buffer to media source ' + sb._mimeType, [chunk], sb, this._mediaSource.readyState);
                    }
                    /**/

                    if (chunk.duration) {
                        var time = sb.buffered.length ? sb.buffered.end(0) : 0;
                        /**
                        var start = time;
                        var end = time + chunk.duration;

                        if (d) {
                            var b = [];
                            for (var i = 0; i < sb.buffered.length; ++i) {
                                b.push(sb.buffered.start(i) + '-' + sb.buffered.end(i));
                            }
                            console.debug('ranges(%s), timecode=%s, duration=%s, time=%s, start=%s(%s), end=%s(%s)',
                                b.join(', '), chunk.timecode, chunk.duration, time,
                                start, sb.appendWindowStart, end, sb.appendWindowEnd,
                                sb.timestampOffset, chunk.seektime);
                        }
                        /**/

                        if (chunk.seektime !== undefined && (!time || time > chunk.seektime)) {
                            time = chunk.seektime;
                        }

                        sb.timestampOffset = time;
                        // sb.appendWindowStart = start;
                        // sb.appendWindowEnd = end;
                    }

                    sb.appendBuffer(new Uint8Array(chunk).buffer);
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
                    else {
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

    mediaSource._flow = function() {
        if (this.destroyed || !this._sourceBuffer || this._sourceBuffer.updating || videoFile.throttle) {
            return;
        }

        if (this._cb) {
            var cb = this._cb;
            this._cb = null;
            cb();
        }
    };

    mediaSource.on('error', function(err) {
        videoStream._elemWrapper.error(err)
    });

    return mediaSource;
};

VideoStream.prototype._pump = function(time) {
    try {
        var video = this._elem;
        if ((time | 0) > 0) {
            video.currentTime = time;
        }
        time = video.currentTime;

        if (this._type !== 'WebM' || !this.withinBufferedRange(time)) {
            var self = this;
            delay('vs:pump-track', tryCatch(function() {
                self._tryPump(time);
            }, function(ex) {
                self._elemWrapper.error(ex);
            }), 250);
        }
        else if (d) {
            console.debug('Ignoring pump within buffered range.', time);
        }
    }
    catch (ex) {
        this._elemWrapper.error(ex);
    }
};

VideoStream.prototype._tryPump = function(time) {
    var self = this;
    var video = self._elem;
    var muxer = self._muxer;
    var muxed = muxer.seek(time);
    var timeStampFixup = muxer._seekTimeFixup;

    if (d) {
        console.debug('Seeking to %s, fixup=%s', time, timeStampFixup);
    }

    if (time - timeStampFixup > .4 || timeStampFixup === 0) {
        var i, m;

        if (self._seekCoercion === timeStampFixup) {
            if (d) {
                console.debug('Seek coercion, waiting for more data...');
            }
        }
        else {
            if (d) {
                console.debug('Applying timestamp fixup...', time, timeStampFixup);
            }

            for (i = muxed.length; i--;) {
                m = muxed[i];
                if (m.inStream) {
                    m.inStream.destroy();
                }
                if (m.outStream) {
                    m.outStream.destroy();
                }
            }

            self._seekCoercion = timeStampFixup;
            video.currentTime = timeStampFixup;

            // if (!this.withinBufferedRange(timeStampFixup)) {
            //     this._tryPump(timeStampFixup);
            // }
            this._tryPump(timeStampFixup);
            return;
        }
    }

    self._tracks.forEach(function(track, i) {
        var pumpTrack = function() {
            if (track.muxed) {
                var ms = track.mediaSource;
                var sb = ms && ms._sourceBuffer;

                track.muxed.destroy();
                track.mediaSource = self.createWriteStream(ms);
                // self._flushSourceBuffers(-1)

                if (sb) {
                    if (ms._type === 'audio/mpeg') {
                        // Needed for Chrome to allow seeking to work properly with raw mp3 streams
                        sb.timestampOffset = time;
                    }

                    if (timeStampFixup !== undefined) {
                        self.removeBuffered(sb, time);
                    }
                }
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

VideoStream.prototype.removeBuffered = function(sb, currentTime) {
    if (sb.buffered.length) {
        var startRange = sb.buffered.start(0);
        var endRange = sb.buffered.end(sb.buffered.length - 1);

        if (d) {
            console.debug('Removing source buffered range (%s:%s-%s)', currentTime, startRange, endRange);
        }

        if (currentTime > startRange && currentTime < endRange) {
            startRange = currentTime;
        }

        sb.remove(startRange, endRange);
        return true;
    }

    return false;
};

VideoStream.prototype.withinBufferedRange = function(time, sb) {
    var ranges = this.getBufferedRange(sb);

    return time > ranges[0] && ranges[1] > time;
};

VideoStream.prototype.getBufferedRange = function(sb) {
    if (!sb) {
        var tk = this._tracks;
        var ms = tk && tk[0].mediaSource;
        sb = ms && ms._sourceBuffer;
    }

    return (sb && sb.buffered.length) ? [sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1)] : false;
};

VideoStream.prototype.findTimeGAPs = function() {
    var gap = {};
    this.forEachBufferedRanges(function(sb, sr, er, ct, ms, tid, bid) {
        if (bid && !gap[tid]) {
            gap[tid] = 1;
            console.warn('SourceBuffer has a gap!', [sb], [ms]);
        }

        if (gap[tid]) {
            console.debug('buffer gap on track%s(%s), sr=%s, er=%s, ct=%s', tid, bid, sr, er, ct);
        }
    });
};

VideoStream.prototype.forEachBufferedRanges = function(cb) {
    if (this._tracks) {
        var trackId, j, currentTime = this._elem.currentTime, sb, startRange, endRange, ms;

        for (trackId = this._tracks.length; trackId--;) {
            ms = this._tracks[trackId].mediaSource._mediaSource;
            sb = this._tracks[trackId].mediaSource._sourceBuffer;

            for (j = sb.buffered.length; j--;) {
                try {
                    endRange = sb.buffered.end(j);
                    startRange = sb.buffered.start(j);

                    cb.call(this, sb, startRange, endRange, currentTime, ms, trackId, j);
                }
                catch (ex) {
                    console.debug(ex);
                }
            }
        }
    }
};

// Flush source buffers when seeking backward or forward
VideoStream.prototype._flushSourceBuffers = function(mode) {
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
        var time = 0;

        if (this._muxer instanceof MP4Remuxer) {
            var trak = this._muxer._tracks[0] || false;
            var smpl = trak && trak.samples[trak.currSample] || false;
            time = (smpl.dts + smpl.duration) / trak.timeScale;

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
            }

            return time - this._elem.currentTime;
        }

        if (this._muxer instanceof EBMLRemuxer) {
            for (var i = Object(this._tracks).length; i--;) {
                var mediaSourceStream = this._tracks[i].mediaSource;
                var mediaSource = mediaSourceStream && mediaSourceStream._mediaSource;

                if (mediaSource.readyState === 'open') {
                    time = Math.max(time, mediaSourceStream._getBufferDuration());
                }
            }
        }

        return time;
    }
});
