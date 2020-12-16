'use strict';

var MAX_CACHE = localStorage.maxStreamingCache | 0 || (500 * 1048576);
var MIN_CACHE = localStorage.minStreamingCache | 0 || (400 * 1048576);
var REQUEST_SIZE = 4 * 1048576;
var MAX_BUF_SECONDS = 25;
var SIMULATE_RESUME_FROM_STALLED = false;

var VideoStream = require('../videostream');
var AudioStream = require('../audiostream');
var inherits = require('inherits');
var Readable = require('readable-stream').Readable;
var Buffer = require('buffer').Buffer;

if (window.safari) {
    MIN_CACHE >>= 2;
    MAX_CACHE >>= 2;
}

function CacheStream(pos, file) {
    if (!(this instanceof CacheStream)) {
        return new CacheStream(pos, file);
    }

    Readable.call(this);
    if (!file.cache) {
        return this;
    }
    this.pos = pos;
    this._file = file;
    this._file.stream = this;

    // prevent premature purging of the following cached chunks
    var bytesleft = file.minCache;
    var p = file.cachefind(pos);
    if (p < 0) {
        p = -p - 1;
    }
    file.mru++;

    while (p < file.cachepos.length && bytesleft > 0) {
        pos = file.cachepos[p++];
        bytesleft -= file.cache[pos].byteLength;
        file.cachemru[pos] = file.mru;
    }
}

inherits(CacheStream, Readable);

CacheStream.prototype._read = function(size) {
    size = window.chrome ? 1048576 : 262144;

    if (!this._file || !this._file._vs) {
        // streamer destroyed
        return
    }

    var videoFile = this._file;
    var videoStream = videoFile._vs;
    var fileSize = videoFile.filesize;
    var currentTime = videoStream._elem.currentTime;
    var bufTime = currentTime && !videoFile.seeking && videoStream.bufTime;

    if (bufTime > MAX_BUF_SECONDS) {
        videoFile.throttle = currentTime + bufTime;

        if (d) {
            console.debug('[CacheStream._read()] Max buffered seconds reached, ' +
                'throttling until %s (current playback time is %s)...',
                secondsToTime(videoFile.throttle),
                secondsToTime(currentTime)
            );
        }
        return;
    }

    while (size) {
        var p = videoFile.cachefind(this.pos);

        if (p < 0) {
            videoFile.fetch(this.pos);
// do this at eof?
//	    	this.push(null);
            break;
        }

        p = videoFile.cachepos[p];
        var offset = this.pos - p;
        var t = size;
        if (videoFile.cache[p].byteLength - offset < t) {
            t = videoFile.cache[p].byteLength - offset;
        }
        if (t <= 0) {
            break;
        }
        size -= t;
        this.pos += t;

        // bump MRU
        videoFile.cachemru[this.pos] = videoFile.mru++;

        if (!this.push(Buffer.from(videoFile.cache[p], offset, t))) {
            break;
        }
    }

    if (fileSize && this.pos === fileSize) {
        // signal eof
        this.push(null);
    }
};

CacheStream.prototype._destroy = function(err, cb) {
    var file = this._file || false;
    if (file.cache) { // if not destroyed
        file.stream = false;
    }
    cb(err || !file.cache);
};

function VideoFile(data, streamer) {
    this.data = data;
    this.stream = null;
    this.streamer = streamer;

    this.cache = Object.create(null);
    this.cachemru = Object.create(null);
    this.fetching = Object.create(null);

    this.cachepos = [];  // ordered array of cache.keys()
    this.cachesize = 0;

    this.mru = 0;
    this.curfetch = 0;
    this.filesize = -1;

    this.throttle = 0;
    this.backoff = 200;
    this.paused = true;
    this.playing = false;
    this.canplay = false;
    this.overquota = false;
    this.bgtask = !streamer.options.autoplay;
    this.retryq = [];

    this.minCache = MIN_CACHE;
    this.maxCache = MAX_CACHE;

    if (data instanceof Blob) {
        this.minCache = 64 * 1048576;
        this.maxCache = 80 * 1048576;
        this.fetcher = this.fileReader;
    }

    window.addEventListener('online', this);
}

VideoFile.prototype = Object.create(null);

Object.defineProperty(VideoFile.prototype, 'isOnline', {
    get: function() {
        return navigator.onLine !== false;
    }
});

VideoFile.prototype.handleEvent = function(ev) {
    if (d) {
        console.debug('[VideoFile.handleEvent()]', ev.type, ev);
    }

    if (ev.type === 'online' && !this.overquota) {
        this.flushRetryQueue();
    }
};

VideoFile.prototype.destroy = function() {
    var keys = Object.keys(this);

    for (var i = keys.length; i--;) {
        delete this[keys[i]];
    }

    window.removeEventListener('online', this);
    Object.freeze(this);
};

VideoFile.prototype.reset = function() {
    // Free up memory used by the cache when no longer needed.
    window.removeEventListener('online', this);
    VideoFile.call(this, this.data, this.streamer);
};

VideoFile.prototype.flushRetryQueue = function() {
    if (this.retryq && this.retryq.length) {
        for (var i = 0; i < this.retryq.length; i++) {
            later(this.retryq[i]);
        }
        this.retryq = [];
        this.overquota = false;
    }
};

VideoFile.prototype.createReadStream = function(opts) {
    return new CacheStream(opts.start || 0, this);
};

// returns index in cachepos[] or -gap-1
VideoFile.prototype.cachefind = function cachefind(pos) {
    // find result with O(log n) complexity
    var max = this.cachepos.length;

    // nothing cached?
    if (!max) {
        return -1;
    }

    // at beginning?
    if (pos < this.cachepos[0]) {
        return -1;
    }

    var min = 0;

    // bisect
    for (; ;) {
        var mid = (min + max) >> 1;

        if (pos >= this.cachepos[mid]) {
            var n = this.cache[this.cachepos[mid]];
            if (!n) {
                return -1;
            }
            if (pos < this.cachepos[mid] + n.byteLength) {
                return mid;
            }
            min = mid + 1;
        }
        else {
            max = mid;
        }

        if (min == max) {
            return -max - 1;
        }
    }
};

VideoFile.prototype.cacheadd = function cacheadd(pos, data) {
    var gap = this.cachefind(pos);

    if (gap >= 0) {
        console.error("*** Mediacache: Internal error - clash");
        return;
    }

    gap = -gap - 1;

    if (gap < this.cachepos.length) {
        if (pos + data.byteLength > this.cachepos[gap]) {
            console.error("*** Mediacache: Internal error - overlap");
            return;
        }
    }

    this.cachepos.splice(gap, 0, pos);
    this.cache[pos] = data;
    this.cachemru[pos] = this.mru++;
    this.cachesize += data.byteLength;

    if (this.cachesize > this.maxCache) {
        var self = this;
        var purge = this.cachepos.slice(0);
        purge.sort(function(a, b) {
            return (self.cachemru[a] > self.cachemru[b]) - (self.cachemru[a] < self.cachemru[b])
        });

        for (var i = 0; this.cachesize > this.minCache; i++) {
            var p = purge[i];

            this.cachesize -= this.cache[p].byteLength;
            delete this.cache[p];
            delete this.cachemru[p];
            this.cachepos.splice(this.cachepos.indexOf(p), 1);
        }
    }
};

VideoFile.prototype.fetcher = function(data, byteOffset, byteLength) {
    if (SIMULATE_RESUME_FROM_STALLED && byteOffset > (REQUEST_SIZE * 8)) {
        return MegaPromise.reject({target: {status: 509}}, data);
    }
    return new MegaPromise(function(resolve, reject) {
        M.gfsfetch(data, byteOffset, byteLength).fail(reject).done(function(data) {
            var buffer = data.buffer;
            delete data.buffer;

            resolve([data, buffer]);
        });
    });
};

VideoFile.prototype.fileReader = function(data, byteOffset, byteLength) {
    if (byteOffset > data.size) {
        return Promise.reject(ERANGE);
    }
    return new Promise(function(resolve, reject) {
        var blob = data.slice(byteOffset, byteLength);
        var reader = new FileReader();
        reader.onload = function() {
            resolve({buffer: reader.result, s: data.size});
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
    });
};

// start new fetch at the next uncached position after pos (unless one is already running)
VideoFile.prototype.fetch = function fetch(startpos, recycle) {
    var self = this;
    var pos = startpos;
    var p;

    if (recycle && (/*this.throttle ||*/ this.paused) && this.cachesize >= this.minCache && this.canplay) {
        if (d) {
            console.debug('[VideoFile.fetch()] MIN_CACHE reached, ' +
                'will not fetch more data until no longer %s...', this.paused ? 'paused' : 'throttled');
        }
        return;
    }

    // prune fetch - rules:
    // - if there is a fetch running that ensures that startpos itself is going to be
    // satisfied, do nothing
    // - if there is a fetch running extending the cached range following startpos, do nothing
    // - shorten the length to ensure that there will be no cache overlaps

    if (this.mru === undefined) {
        // destroyed while loading
        return;
    }
    this.curfetch += !recycle;

    var length;

    do {
        length = REQUEST_SIZE;

        // skip cached data
        while ((p = this.cachefind(pos)) >= 0) {
            pos = this.cachepos[p] + this.cache[this.cachepos[p]].byteLength;
            length = 0;	// go for another round
        }

        // skip the following completing fetches
        while (this.fetching[pos]) {
            pos += this.fetching[pos];
            length = 0;	// go for another round
        }
    } while (!length);

    // make sure the block fetch does not overlap with cached items
    // (no need to repeat the call to cachefind())
    p = -p - 1;

    if (p < this.cachepos.length) {
        var t = this.cachepos[p] - pos;
        if (t < length) {
            length = t;
        }
    }

    // also, make sure the block fetch does not overlap with active fetches
    for (p in this.fetching) {
        p = p * 1;	// make sure that this is actually numeric (IT'S A TRAP!)

        if (pos >= p && pos < p + this.fetching[p]) {
            return;
        }

        if (p >= pos && p - pos < length) {
            length = p - pos;
        }
    }

    // also, never exceed the file size
    if (this.filesize >= 0 && pos + length >= this.filesize) {
        length = this.filesize - pos;
    }

    if (length < 1) {
        if (length < 0) {
            if (d && this.filesize >= 0) {
                console.error("*** Mediacache: Internal error - out of bound.", startpos, pos, length);
            }
        }
        return;
    }

    this.fetching[pos] = length;

    var thisfetch = this.curfetch;

    if (d) {
        console.debug('Fetching %s-%s, length=%s...', pos, pos + length, length);
    }

    this.fetcher(this.data, pos, pos + length)
        .then(function(data) {
            var buffer = data.buffer;

            if (Array.isArray(data)) {
                buffer = data[1];
                data = data[0];
            }

            if (self.mru === undefined) {
                // destroyed while loading
                return;
            }

            if (typeof self.data === 'string') {
                data._ticket = self.data;
                self.data = data;
            }

            if (self.filesize < 0) {
                self.filesize = data.s;
            }

            delete self.fetching[pos];

            self.cacheadd(pos, buffer);
            pos += buffer.byteLength;

            if (thisfetch === self.curfetch) {
                setTimeout(self.fetch.bind(self, pos, 1), 100);
            }

            self.backoff = 200;
            // self.overquota = false;

            self.feedPlayer();
        })
        .catch(function(ev, data) {
            var xhr = ev && ev.target || false;

            if (self.mru === undefined) {
                // destroyed while loading
                return;
            }
            delete self.fetching[pos];

            var retry = function() {
                queueMicrotask(self.fetch.bind(self, startpos, recycle));
            };

            if (typeof ev === 'number') {
                if (ev !== ERANGE || data && pos < data.s) {
                    if (d) {
                        console.warn('Unrecoverable stream fetch error, aborting...', self.isOnline, ev, pos);
                    }
                    self.streamer.notify('error', new Error(api_strerror(ev)));
                }
            }
            else if (xhr.status === 509) {
                if (d) {
                    console.warn('stream overquota, holding...', ev);
                }

                if (typeof self.data === 'object') {
                    self.data = self.data._ticket;
                }
                self.overquota = true;
                self.retryq.push(retry);
                self.streamer._setActivityTimer();
            }
            else {
                if (d) {
                    console.warn('stream fetch error, retrying...', self.isOnline, ev);
                }

                if (self.isOnline) {
                    if (!xhr.status) {
                        // retry immediately if e.g. error 0x2ef3 on MSIE...
                        retry();
                    }
                    else {
                        self.backoff = Math.min(self.backoff << 1, 7e3);
                        setTimeout(retry, self.backoff);
                    }
                }
                else {
                    self.retryq.push(retry);
                }
            }
        });

    return this;
};

// feed to video layer
VideoFile.prototype.feedPlayer = function() {
    if (this.stream) {
        try {
            this.stream._read(0);
        }
        catch (ex) {
            this.streamer.notify('error', ex);
        }
    }
};

/**
 * Start streaming a MEGA file.
 * @param {String} data The data needed by gfsfetch()
 * @param {Object} video The <video> element
 * @param {Object} [options] Additional options
 * @constructor
 * @preserve
 */
function Streamer(data, video, options) {
    var uad = ua.details;

    if (!(this instanceof Streamer)) {
        return new Streamer(data, video, options);
    }
    this.gecko = uad.engine === 'Gecko';
    this.msie = "ActiveXObject" in window || window.MSBlobBuilder;
    this.options = options || Object.create(null);
    if (this.options.autoplay === undefined) {
        this.options.autoplay = true;
    }

    this._events = [
        'progress', 'timeupdate', 'canplay', 'pause', 'playing', 'error',
        'abort', 'updateend', 'ended', 'stalled', 'suspend'
    ];
    if (video.parentNode && this.gecko && parseInt(uad.version) < 57) {
        this.sbflush = true;
        this._events.push('seeking');
        this.WILL_AUTOPLAY_ONSEEK = true;
    }

    for (var i = this._events.length; i--;) {
        video.addEventListener(this._events[i], this, false);
    }

    this.state = false;
    this.video = video;
    this.timeupdate = 0;
    this.stalled = false;
    this.evs = Object.create(null);
    this.presentationOffset = 0;
    this.playbackTook = Date.now();
    this.playbackEvent = false;
    this.playbackSeeking = false;

    if (d && window.vssrfs) {
        SIMULATE_RESUME_FROM_STALLED = true;
    }

    if (this.options.type === undefined) {
        // No type given, try to guess if that's a webm otherwise it'll fallback to mp4

        this.initTypeGuess(data);
    }
    else {
        this.init(data);
    }

    if (d) {
        window.strm = this;
    }
}

Streamer.prototype = Object.create(null);

Streamer.prototype.init = function(data) {
    var self = this;

    if (!self.video) {
        if (d) {
            console.debug('Cannot initialize... already destroyed?', self);
        }
        return;
    }
    self.file = new VideoFile(data, self);

    if (self.options.autoplay === false) {
        self.file.minCache = 0x1000000;
    }
    else {
        self.video.setAttribute('autoplay', true);
    }

    var options = Object.assign(self.options, {
        sbflush: self.sbflush,
        bufferDuration: MAX_BUF_SECONDS * 1.8
    });

    if (this.goAudioStream) {
        self.stream = new AudioStream(self.file.fetch(0), self.video, options);

        ['error', 'audio-buffer'].forEach(function(ev) {
            self.stream.on(ev, function(a) {
                self.notify(ev, a);
            });
        });
    }
    else {
        self.stream = new VideoStream(self.file.fetch(0), self.video, options);

        if (self.gecko) {
            // Listen for the first stalled event...
            // ...in a lame attempt to workaround https://bugzilla.mozilla.org/show_bug.cgi?id=1350056
            // TODO: fix the mp4 remuxer instead...

            var waiting = false;
            (function _() {
                if (waiting) {
                    return;
                }
                waiting = true;

                self.on('stalled', function() {
                    var stream = this.stream;
                    var range = stream.getBufferedRange();

                    if (d) {
                        console.log('First range on stalled', range, this.timeupdate);
                    }

                    if (!this.timeupdate && range[0] > 1) {
                        console.warn('Applying presentation timestamp fixup...', range);
                        this.presentationOffset = range[0];
                        this.currentTime = 0;
                    }

                    waiting = !range;
                    return waiting;
                });
                self.on('ended', _);
            })();
        }
    }
    self.file._vs = self.stream;
};

Streamer.prototype.initTypeGuess = function(data) {
    var self = this;
    var file = new VideoFile(data, self);
    var init = function(data) {
        file.destroy();
        self.init(data);
    };

    file.fetcher(data, 0, 16)
        .then(function(chunk) {
            var buffer = chunk.buffer;
            delete chunk.buffer;

            if (Array.isArray(chunk)) {
                buffer = chunk[1];
                chunk = chunk[0];
            }

            var dv = new DataView(buffer);
            var long = dv.getUint32(0, false);

            if (long === 0x1A45DFA3) {
                self.options.type = 'WebM';
            }
            else if ((long >> 8) === 0x494433) {
                self.options.type = 'MPEG Audio';
            }
            else if (long === 0x4F676753) {
                self.options.type = 'Ogg';
            }
            else if (long === 0x664C6143) {
                self.options.type = 'FLAC';
            }
            else if (dv.getUint32(8, false) === 0x4D344120) {
                self.options.type = 'M4A ';
            }
            else if (dv.getUint32(8, false) === 0x57415645) {
                self.options.type = 'Wave';
            }
            init(typeof data === 'string' ? chunk : data);
        })
        .catch(function(ex) {
            if (d) {
                console.debug('Type guess failed...', ex);
            }
            init(data);
        });
};

Streamer.prototype.destroy = function() {
    var i;

    if (d) {
        console.debug('Destroying Streamer instance.', this);
    }
    this._clearActivityTimer();

    try {
        if (this.stream) {
            this.stream.destroy();
        }
    }
    catch (ex) {
        console.warn(ex);
    }
    if (this.file) {
        this.file.destroy();
    }

    if (this.video) {
        for (i = this._events.length; i--;) {
            this.video.removeEventListener(this._events[i], this, false);
        }

        // recreate the video element to prevent possible leaks..
        if (this.video.parentNode) {
            var video = this.video;
            var clone = video.cloneNode();
            var parent = video.parentNode;

            try {
                // Edge will preserve the previous offset otherwise...
                clone.currentTime = 0;
            }
            catch (ex) {}

            clone.removeAttribute('src');
            clone.removeAttribute('autoplay');
            parent.removeChild(video);
            parent.appendChild(clone);
        }
    }

    delete this.evs;
    delete this.file;
    delete this.video;
    delete this.stream;
};

Streamer.prototype.onPlayBackEvent = function(playing) {
    var videoFile = this.file;

    if (videoFile.paused) {
        videoFile.paused = false;
        if (videoFile.stream) {
            if (d) {
                console.debug('Was paused, continuing fetching data...');
            }
            videoFile.fetch(videoFile.stream.pos);
        }
    }

    if (playing) {
        videoFile.playing = true;
        videoFile.seeking = false;

        if (!this.playbackEvent) {
            this.playbackEvent = true;
            this.playbackTook = Date.now() - this.playbackTook;
        }
        this.playbackSeeking = false;

        if (this.stalled) {
            this.stalled = false;
            this.notify('activity');

            // XXX: on MSIE the video continues stalled while audio does play, seeking back fixes it..
            if (this.msie) {
                // this.video.currentTime = this.video.currentTime - .2;
            }
        }
    }
};

Streamer.prototype.handleEvent = function(ev) {
    var target = ev.target;
    var videoFile = this.file;

    if (d && ev.type !== 'timeupdate' || d > 2) {
        console.debug('Event(%s)', ev.type, target, ev);
    }
    this.state = ev.type;

    if (!videoFile) {
        if (d) {
            console.warn('VideoFile instance is not available, already destroyed?', ev.type, [this]);
        }
        return false;
    }

    switch (ev.type) {
        case 'seeking':
            videoFile.seeking = true;
            this.stream.flushSourceBuffers();

            if (this.video.paused) {
                queueMicrotask(this.play.bind(this));
            }
        /* fallthrough, to clear the paused flag */
        case 'playing':
            this.onPlayBackEvent(ev.type === 'playing');
            break;

        case 'pause':
            videoFile.paused = true;
            videoFile.playing = false;
            this._clearActivityTimer();
            break;

        case 'progress':
            target.removeEventListener('progress', this);

            if (d > 1) {
                var ew = this.stream._elemWrapper;
                var ms = ew && ew._mediaSource;
                if (ms) {
                    ms.addEventListener('sourceclose', console.warn.bind(console));
                    ms.addEventListener('sourceended', console.warn.bind(console));
                }
            }

            if (videoFile.playing) {
                break;
            }
        /* fallthrought */
        case 'canplay':
            videoFile.canplay = true;
            if (ev.type === 'canplay') {
                delay.cancel('vs:pump-track');
            }
            if (this.options.autoplay && !videoFile.playing) {
                this.play();
            }
            break;

        case 'ended':
            this._clearActivityTimer();
            this.stream.flushSourceBuffers(-1);
            break;

        case 'timeupdate':
            if (videoFile.throttle && videoFile.throttle - target.currentTime < (MAX_BUF_SECONDS / 3)) {
                if (d) {
                    console.debug('[Streamer.timeupdate] Throttle threshold %s reached at playback time %s, resuming...',
                        secondsToTime(videoFile.throttle),
                        secondsToTime(target.currentTime),
                        !!videoFile.stream);
                }
                videoFile.throttle = 0;

                if (videoFile.stream) {
                    videoFile.stream._read(0);
                }
            }

            // console.warn('timeupdate', this.timeupdate, target.currentTime, target.readyState, this.stalled);

            // XXX: MSIE keeps firing 'timeupdate' even if stalled :(
            if (this.timeupdate !== target.currentTime) {
                this.timeupdate = target.currentTime;

                // XXX: MSIE won't signal 'playing' on no longer stalled :(
                if (this.stalled && target.readyState > 2) {
                    this.onPlayBackEvent(true);
                }

                // XXX: MSIE may fires a timeupdate after a pause, causing
                // the overquota dialog to come up when it should not.. :(
                if (!videoFile.paused) {
                    this._setActivityTimer();
                }
            }
            break;
    }

    if (this.evs[ev.type]) {
        var error;

        if (ev.type === 'error') {
            var mediaError = target.error || false;
            var streamError = Object(this.stream._elemWrapper).detailedError;
            error = streamError && streamError.message || mediaError.message;

            if (mediaError.code) {
                console.warn('MediaError %s', mediaError.code, mediaError.message);
            }
            if (streamError) {
                console.warn('StreamError', streamError);
            }
        }
        this.notify(ev, error || false);
    }
};

Streamer.prototype.retry = function() {
    debugger;
    SIMULATE_RESUME_FROM_STALLED = false;
    dlmanager._onQuotaRetry(true);
};


Streamer.prototype.play = function() {
    // Some browsers, such as Chrome Android, will throw:
    // Failed to execute 'play' on 'HTMLMediaElement': API can only be initiated by a user gesture.
    try {
        var self = this;
        var stream = self.stream;
        if (stream instanceof AudioStream) {
            var ctx = stream._audioContext || false;

            if (ctx.state === 'suspended') {
                ctx.resume();
            }
        }
        var promise = self.video.play();

        if (typeof Promise !== 'undefined' && promise instanceof Promise) {
            promise.then(function() {
                if (d) {
                    console.debug('Playing, current time: %s, duration: %s',
                        secondsToTime(self.currentTime),
                        secondsToTime(self.duration));
                }
                if (stream instanceof AudioStream) {
                    // XXX: if no autoplay, it then *may* does fail to play on demand - enough fixup?
                    stream._play(self.currentTime);
                }
            }).catch(function(ex) {
                if (d) {
                    console.debug('video.play() failed...', ex);
                }
            });
        }
    }
    catch (ex) {
    }

    var videoFile = this.file || false;
    if (videoFile.bgtask) {
        videoFile.bgtask = false;
        videoFile.minCache = MIN_CACHE;

        if (!videoFile.overquota) {
            videoFile.flushRetryQueue();
        }
        this.options.autoplay = true;
    }

    if (videoFile) {
        this._setActivityTimer();
    }
};

Streamer.prototype.on = function(ev, success, error) {
    if (this.evs) {
        success = tryCatch(success.bind(this), error);

        if (this.evs[ev]) {
            this.evs[ev].push(success);
        }
        else {
            this.evs[ev] = [success];
        }
    }

    return this;
};

Streamer.prototype.notify = function(ev) {
    var type = String(typeof ev === 'object' && ev.type || ev);

    if (this.evs[type]) {
        var args = new Array(arguments.length);
        for (var i = args.length; i--;) {
            args[i] = arguments[i];
        }

        if (typeof ev !== 'object') {
            args[0] = {
                type: type,
                target: this
            };
        }

        var result = this.evs[type].filter(function(cb) {
            return cb.apply(null, args);
        });

        // an error callback may destroys this instance
        if (this.evs) {
            this.evs[type] = result;

            if (!this.evs[type].length) {
                delete this.evs[type];
            }
        }
    }
};

Streamer.prototype._clearActivityTimer = function() {
    delay.cancel('vs:activity-timer');
};

Streamer.prototype._setActivityTimer = function() {
    var self = this;
    var stream = self.stream;
    if (stream instanceof AudioStream) {
        // audio files cannot get into buffering...
        return;
    }

    delay('vs:activity-timer', function() {
        var file = self.file;
        var video = self.video || false;

        if (!video.paused && !video.ended || !file.bgtask && self.isOverQuota) {
            self.stalled = true;
            self.notify('inactivity');

            // Deal with Safari.. playback might be ready but no canplay event fired yet..
            if (self.state === 'suspend' && !self.playbackEvent) {
                if (d) {
                    console.warn('Got suspend event, performing time fixup...');
                }
                self.currentTime += 0.1;
            }

            // We used to handle stalled events... http://crbug.com/836951
            self.handleEvent({type: 'stalled', fake: 1, target: video});
        }
    }, 1600);
};

Streamer.prototype.getImage = function(w, h) {
    var self = this;
    var video = this.video;

    return new Promise(function _(resolve, reject) {
        if (!video.videoWidth) {
            queueMicrotask(function() {
                reject(-9);
            });
            return;
        }
        var dim = self.dim(video.videoWidth, video.videoHeight, w || 1280, h || 720);

        if (d) {
            console.debug('[Streamer.getImage()] Taking %sx%s image from %sx%s at %s',
                dim.width, dim.height, video.videoWidth, video.videoHeight, secondsToTime(video.currentTime));
        }

        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        canvas.width = Math.round(dim.width);
        canvas.height = Math.round(dim.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        var ab = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        var i, len = i = ab.byteLength, bp = 0;
        while (i--) {
            if (ab[i] < 10) {
                bp++;
            }
        }

        if (Math.round(bp * 100 / len) > 70) {
            if (d) {
                console.debug('[Streamer.getImage()] Got +70% of black pixels, retrying...');
            }

            if (video.paused || video.ended || window.safari) {
                // nb: https://bugs.webkit.org/show_bug.cgi?id=206812
                queueMicrotask(function() {
                    reject(-5);
                });
            }
            else {
                setTimeout(_.bind(this, resolve, reject), 800);
            }
        }
        else {
            resolve(dataURLToAB(canvas.toDataURL('image/png')));
        }
    });
};

Streamer.prototype.dim = function(srcWidth, srcHeight, maxWidth, maxHeight) {
    var ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight);
    return {width: srcWidth * ratio, height: srcHeight * ratio, ratio: ratio};
};

Streamer.getThumbnail = function(data) {
    return new Promise(function(resolve, reject) {
        var video = document.createElement('video');
        video.muted = true;

        var step = -1;
        var s = Streamer(data, video);
        var _reject = function(e) {
            s.destroy();
            reject(e);
        };
        var _resolve = function(ab) {
            resolve(ab);
            s.destroy();
        };

        s.on('playing', function() {
            if (!++step) {
                this.currentTime = 20 * (video.duration | 0) / 100;
                return true;
            }

            s.getImage().then(_resolve).catch(_reject);
        });

        s.on('error', _reject);
    });
};

Streamer.prototype.getProperty = function(key) {
    var file = this.file || false;

    switch (key) {
        case 'server':
            var data = file.data;
            var url = data && data.g;
            return url && String(url).split('//').pop().split('.')[0] || false;

        case 'bitrate':
            return (file.filesize / this.duration) || false;
    }

    return false;
};

Object.defineProperty(Streamer.prototype, 'gain', {
    set: function(v) {
        var stream = this.stream;

        if (stream instanceof AudioStream) {
            var sn = stream._audioSource || false;

            if (sn.gain) {
                sn.gain.value = v;
            }
        }
    }
});

Object.defineProperty(Streamer.prototype, 'volume', {
    get: function() {
        return (this.video || false).volume;
    },
    set: function(v) {
        var video = this.video || false;
        var vol = v < 0.1 ? 0.1 : v > 1.0 ? 1.0 : v;

        this.gain = vol;
        if (video) {
            video.volume = vol;
        }
    }
});

Object.defineProperty(Streamer.prototype, 'muted', {
    get: function() {
        return (this.video || false).muted;
    },
    set: function(v) {
        var video = this.video || false;

        if (v === -1) {
            v = !this.muted;
        }

        this.gain = !v;
        if (video) {
            video.muted = v;
        }
    }
});

Object.defineProperty(Streamer.prototype, 'duration', {
    get: function() {
        var video = this.video || false;
        return video.duration - this.presentationOffset;
    }
});

Object.defineProperty(Streamer.prototype, 'currentTime', {
    get: function() {
        var video = this.video || false;
        var stream = this.stream || false;

        if (stream instanceof AudioStream) {
            return stream.currentTime;
        }

        return video.currentTime - this.presentationOffset;
    },
    set: function(v) {
        var self = this;
        var video = self.video || false;
        var stream = self.stream || false;

        if (stream instanceof AudioStream) {
            stream._play(v);
            self.play();
        }
        else if (video.readyState) {
            var time = v + self.presentationOffset;
            video.currentTime = time;

            // Attempt to deal with https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/11459883
            // I.e. The 'waiting' event may not actually be timely fired so we'll manually pump the track...
            if (self.msie) {
                stream._pump(time);
            }

            self.play();
        }
        else if (d) {
            console.debug('Ignoring seek attempt, invalid state...');
        }

        this.playbackSeeking = true;
    }
});

Object.defineProperty(Streamer.prototype, 'goAudioStream', {
    get: function() {
        var options = this.options || false;
        var type = options.type;

        if (type === 'M4A ') {
            return mega.fullAudioContextSupport;
        }

        return type === 'MPEG Audio' || type === 'Wave' || type === 'Ogg' || type === 'FLAC';
    }
});

Object.defineProperty(Streamer.prototype, 'hasAudio', {
    get: function() {
        return this.stream && (Object(this.stream._muxer)._hasAudio || this.stream._hasAudio);
    }
});

Object.defineProperty(Streamer.prototype, 'hasUnsupportedAudio', {
    get: function() {
        return this.stream && Object(this.stream._muxer)._hasUnsupportedAudio;
    }
});

Object.defineProperty(Streamer.prototype, 'hasVideo', {
    get: function() {
        return this.stream && Object(this.stream._muxer)._hasVideo;
    }
});

Object.defineProperty(Streamer.prototype, 'isOverQuota', {
    get: function() {
        var file = this.file || false;
        return file.overquota && !Object.keys(file.fetching || {}).length;
    }
});

Object.defineProperty(Streamer.prototype, 'hasStartedPlaying', {
    get: function() {
        return this.playbackEvent && (this.playbackTook || true);
    }
});

Object.defineProperty(Streamer.prototype, 'gotIntoBuffering', {
    get: function() {
        return this.stalled && this.hasStartedPlaying && this.currentTime < this.duration && !this.playbackSeeking;
    }
});

/**
 *  @global
 *  @preserve
 *  @name Streamer
 */
Object.defineProperty(self, 'Streamer', {
    value: Object.freeze(Streamer)
});
