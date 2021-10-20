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
    self._sbQuotaError = null;
    self._trackMeta = null;
    self._file = file;
    self._tracks = null;
    self._type = opts.type;
    self._fpTick = 0;
    self._startTime = opts.startTime;
    if (self._elem.preload !== 'none') {
        self._createMuxer(opts)
    }
    self.flushSourceBuffers = opts.sbflush ? self._flushSourceBuffers : function() {
        if (self._sbQuotaError) {
            var s = file.streamer;
            if (s && s.state === 'stalled') {
                if (d) {
                    console.warn('Forcing pump on quota-error while stalled...');
                }
                self._enqueueForcePump(Math.max(0.3, self._elem.currentTime - 1.2));
            }
        }
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
            self._createMuxer(opts)
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

VideoStream.prototype._createMuxer = function(opts) {
    var self = this;
    var ebml = {'WebM': 1, 'Matroska': 1};
    self._muxer = ebml[self._type] ? new EBMLRemuxer(self._file, opts) : new MP4Remuxer(self._file, opts);
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
    var trace = !localStorage.vsd ? null : function(time, sb, chunk) {
        var start = time;
        var end = time + chunk.duration;

        var b = [];
        for (var i = 0; i < sb.buffered.length; ++i) {
            b.push(sb.buffered.start(i) + '-' + sb.buffered.end(i));
        }
        console.debug('ranges(%s), timecode=%s, duration=%s, time=%s, start=%s(%s), end=%s(%s)',
            b.join(', '), chunk.timecode, chunk.duration, time,
            start, sb.appendWindowStart, end, sb.appendWindowEnd,
            sb.timestampOffset, chunk.seektime);
    };

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
                        /**/
                        if (trace) {
                            trace(time, sb, chunk);
                        }
                        /**/

                        if (chunk.seektime !== undefined && (!time || time > chunk.seektime)) {
                            time = chunk.seektime;
                        }

                        sb.timestampOffset = time;
                        // sb.appendWindowStart = start;
                        // sb.appendWindowEnd = end;
                    }

                    // trace(0, sb, chunk);
                    sb.appendBuffer(new Uint8Array(chunk).buffer);
                    this._cb = cb;
                    return;
                }
                catch (ex) {
                    if (d > 1) {
                        console.debug('Caught %s', ex.name, ex);
                    }
                    if (ex.name === 'QuotaExceededError') {
                        videoStream._sbQuotaError = true;
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
        if (this._cb && !this.destroyed) {
            var sb = this._sourceBuffer;

            if (sb && !sb.updating) {

                if (videoFile.throttle && this._mediaSource.readyState === 'open' && sb.buffered.length) {
                    var t = sb.buffered.end(sb.buffered.length - 1) - this._elem.currentTime;
                    if (t > this._bufferDuration) {
                        return;
                    }
                }

                var cb = this._cb;
                this._cb = null;
                cb();
            }
        }
    };

    mediaSource.on('error', function(err) {
        var elm = videoStream._elemWrapper;
        if (elm) {
            elm.error(err);
        }
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

        if (this._type !== 'WebM' || !this.withinBufferedRange(time + 1)) {
            this._tryPump(time);
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
        var destroy = function(track, instance) {
            try {
                if (track[instance]) {
                    track[instance].destroy();
                }
            }
            catch (ex) {
                console.warn(track, instance, ex);
            }
        };

        for (i = tracks.length; i--;) {
            track = tracks[i];
            destroy(track, 'mediaSource');
            destroy(track, 'muxed');
        }

        self._tracks = false;
    }

    if (String(self._elem.src).startsWith('blob:')) {
        URL.revokeObjectURL(self._elem.src);
    }

    self._elem.removeAttribute('src');
    self._elem = false;
    self._file = false;
    self._elemWrapper = false;
};

VideoStream.prototype.forEachSourceBuffer = function(cb) {
    if (this._tracks) {
        var i, currentTime = this._elem.currentTime, sb, startRange, endRange, ms, src;

        for (i = this._tracks.length; i--;) {
            src = this._tracks[i].mediaSource || false;
            ms = src._mediaSource;
            sb = src._sourceBuffer;

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

VideoStream.prototype.onSourceBufferUpdateEnded = function(sb, cb) {
    if (!sb.updating) {
        return queueMicrotask(cb);
    }
    sb.addEventListener("updateend", function end() {
        sb.removeEventListener("updateend", end);
        queueMicrotask(cb);
    });
};

VideoStream.prototype._enqueueForcePump = function(offset) {
    if (++this._fpTick > 3) {
        return this._forcePump(offset);
    }
    delay('vs.force-track-pump', this._forcePump.bind(this, offset), 2600)
};

VideoStream.prototype._forcePump = function(offset) {
    var self = this;
    var res = 0, step = 0;
    var pump = function() {
        var f = self._file;
        if (!--step && f) {
            if (d) {
                self.forEachBufferedRanges(dump)
            }
            if (f.playing) {
                f.throttle = 0;
                self._pump(offset);
            }
        }
    };

    self._fpTick = 0;
    delay.cancel('vs.force-track-pump');

    if (this._tracks) {
        var t = this._tracks, i, ms, sb;
        for (i = t.length; i--;) {
            ms = t[i].mediaSource;
            sb = ms && ms._sourceBuffer;

            if (!sb || !ms) {
                continue;
            }
            ++step;
            ms._cb = null;
            ms.destroy();

            if (sb.updating) {
                res = -1;
                this.onSourceBufferUpdateEnded(sb, this.removeBuffered.bind(this, sb, null, pump));
            }
            else {
                res |= this.removeBuffered(sb, null, pump);
            }
        }
    }
    if (!step) {
        pump(++step);
    }
    return res;
};

VideoStream.prototype.removeBuffered = function(sb, currentTime, callback) {
    if (sb.buffered.length) {
        var startRange = sb.buffered.start(0);
        var endRange = sb.buffered.end(sb.buffered.length - 1);

        if (d) {
            console.debug('Removing source buffered range (%s:%s-%s)', currentTime, startRange, endRange);
        }

        if (currentTime > startRange && currentTime < endRange) {
            startRange = currentTime;
        }

        tryCatch(sb.remove.bind(sb, startRange, endRange), d > 2 ? dump : false)();
        if (callback) {
            this.onSourceBufferUpdateEnded(sb, callback);
        }
        return true;
    }

    if (callback) {
        queueMicrotask(callback);
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
    var gap = {}, res = 0;
    this.forEachBufferedRanges(function(sb, sr, er, ct, ms, tid, bid) {
        if (bid && !gap[tid]) {
            gap[tid] = res = 1;
            console.warn('SourceBuffer has a gap!', [sb], [ms]);
        }

        if (gap[tid]) {
            console.debug('buffer gap on track%s(%s), sr=%s, er=%s, ct=%s', tid, bid, sr, er, ct);
        }
    });
    return res;
};

VideoStream.prototype.forEachBufferedRanges = function(cb) {
    if (this._tracks) {
        var trackId, j, currentTime = this._elem.currentTime, sb, startRange, endRange, ms, src;

        for (trackId = this._tracks.length; trackId--;) {
            src = this._tracks[trackId].mediaSource || false;
            ms = src._mediaSource;
            sb = src._sourceBuffer;

            for (j = sb && sb.buffered.length; j--;) {
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
VideoStream.prototype._flushSourceBuffers = function(mode, track) {
    var res = false;
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
                    endRange = currentTime;
                }
                if (startRange >= currentTime) {
                    return;
                }
            }

            if (endRange > startRange && (endRange - startRange) > 1) {
                sb.remove(startRange, endRange);
                if (track) {
                    this.onSourceBufferUpdateEnded(track);
                }
                ++res;

                if (d) {
                    console.log('[VideoStream.flushSourceBuffers] remove took place', startRange, endRange);
                }
            }
        }
    });
    return res;
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
