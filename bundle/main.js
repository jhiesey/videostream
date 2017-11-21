'use strict';

var MAX_CACHE = localStorage.maxStreamingCache | 0 || (500 * 1048576);
var MIN_CACHE = localStorage.minStreamingCache | 0 || (400 * 1048576);
var REQUEST_SIZE = 4 * 1048576;
var MAX_BUF_SECONDS = 25;

var VideoStream = require('../');
var inherits = require('inherits');
var Readable = require('readable-stream').Readable;
var Buffer = require('buffer').Buffer;

function CacheStream(pos, file) {
    if (!(this instanceof CacheStream)) {
        return new CacheStream(pos, file);
    }

    Readable.call(this);
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
};

CacheStream.prototype._destroy = function(err, cb) {
    this._file.stream = false;
    cb(err);
};

function VideoFile(data) {
    this.data = data;
    this.stream = null;

    this.cache = Object.create(null);
    this.cachemru = Object.create(null);
    this.fetching = Object.create(null);

    this.cachepos = [];  // ordered array of cache.keys()
    this.cachesize = 0;

    this.mru = 0;
    this.curfetch = 0;
    this.filesize = -1;

    this.throttle = 0;
    this.paused = false;
    this.playing = false;

    this.minCache = MIN_CACHE;
    this.maxCache = MAX_CACHE;

    if (data instanceof Blob) {
        this.minCache = 10 * 1048576;
        this.maxCache = 40 * 1048576;
        this.fetcher = this.fileReader;
    }
}

VideoFile.prototype = Object.create(null);

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
            if (pos < this.cachepos[mid] + this.cache[this.cachepos[mid]].byteLength) {
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
    return M.gfsfetch(data, byteOffset, byteLength);
};

VideoFile.prototype.fileReader = function(data, byteOffset, byteLength) {
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

    if (recycle && (/*this.throttle ||*/ this.paused) && this.cachesize >= this.minCache) {
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
            console.error("*** Mediacache: Internal error - out of bound.", startpos, pos, length);
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
            delete data.buffer;

            if (self.mru === undefined) {
                // destroyed while loading
                return;
            }

            if (typeof self.data === 'string') {
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
            self.feedPlayer();
        })
        .catch(function(ev, data) {
            if (self.mru === undefined) {
                // destroyed while loading
                return;
            }
            delete self.fetching[pos];

            var retry = function() {
                setImmediate(self.fetch.bind(self, startpos, recycle));
            };

            if (typeof ev === 'number') {
                if (ev !== ERANGE || pos < data.s) {
                    self._vs._onError(new Error(api_strerror(ev)));
                }
            }
            else if (ev.target.status === 509) {
                if (d) {
                    console.warn('stream overquota, holding...', ev);
                }

                dlmanager.showOverQuotaDialog(function() {
                    dlmanager.onNolongerOverquota();
                    retry();
                });
            }
            else {
                if (d) {
                    console.warn('stream fetch error, retrying...', ev);
                }

                retry();
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
            this._vs._onError(ex);
        }
    }
};

/**
 * Start streaming a MEGA file.
 * @param {String} data The data needed by gfsfetch()
 * @param {Object} video The <video> element
 * @constructor
 * @preserve
 */
function Streamer(data, video) {
    if (!(this instanceof Streamer)) {
        return new Streamer(data, video);
    }

    this.engine = ua.details.engine;
    this.browser = ua.details.browser;

    this._events = [
        'progress', 'timeupdate', 'canplay', 'pause', 'playing', 'error', 'abort', 'updateend', 'ended'
    ];
    if (this.browser !== 'Edge' && video.parentNode && !window.chrome) {
        // Edge gets stuck on seeking by listening to..seeking
        this._events.push('seeking');
    }
    for (var i = this._events.length; i--;) {
        video.addEventListener(this._events[i], this, false);
    }

    this.video = video;
    this.evs = Object.create(null);

    this.file = new VideoFile(data);
    this.stream = new VideoStream(this.file.fetch(0), video, {bufferDuration: MAX_BUF_SECONDS * 1.8});
    this.file._vs = this.stream;
}

Streamer.prototype = Object.create(null);

Streamer.prototype.destroy = function() {
    var i, keys = Object.keys(this.file);

    if (d) {
        console.debug('Destroying Streamer instance.', this);
    }

    try {
        this.stream.destroy();
    }
    catch (ex) {
        console.warn(ex);
    }

    if (this.video) {
        for (i = this._events.length; i--;) {
            this.video.removeEventListener(this._events[i], this);
        }

        // recreate the video element to prevent possible leaks..
        if (this.video.parentNode) {
            var video = this.video;
            var clone = video.cloneNode();
            var parent = video.parentNode;

            parent.removeChild(video);
            parent.appendChild(clone);
        }
    }

    for (i = keys.length; i--;) {
        delete this.file[keys[i]];
    }

    delete this.file;
    delete this.video;
};

Streamer.prototype.handleEvent = function(ev) {
    var target = ev.target;
    var videoFile = this.file;

    if (d && ev.type !== 'timeupdate' || d > 1) {
        console.debug('Event(%s)', ev.type, target, ev);
    }

    switch (ev.type) {
        case 'seeking':
            videoFile.seeking = true;
            this.stream.flushSourceBuffers();

            if (this.video.paused) {
                onIdle(this.play.bind(this));
            }
        /* fallthrough, to clear the paused flag */
        case 'playing':
            if (videoFile.paused) {
                videoFile.paused = false;
                if (videoFile.stream) {
                    if (d) {
                        console.debug('Was paused, continuing fetching data...');
                    }
                    videoFile.fetch(videoFile.stream.pos);
                }
            }
            if (ev.type === 'playing') {
                videoFile.playing = true;
                videoFile.seeking = false;
            }
            break;

        case 'pause':
            videoFile.paused = true;
            videoFile.playing = false;
            break;

        case 'canplay':
            this.play();
            break;

        case 'progress':
            target.removeEventListener('progress', this);

            if (!videoFile.playing) {
                this.play();
            }
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
            break;
    }

    if (this.evs[ev.type]) {
        var a1 = ev.type === 'error' && this.stream.detailedError || false;

        this.evs[ev.type] = this.evs[ev.type].filter(function(cb) {
            return cb(ev, a1);
        });

        if (!this.evs[ev.type].length) {
            delete this.evs[ev.type];
        }
    }
};

Streamer.prototype.play = function() {
    // Some browsers, such as Chrome Android, will throw:
    // Failed to execute 'play' on 'HTMLMediaElement': API can only be initiated by a user gesture.
    try {
        var video = this.video;
        var promise = video.play();

        if (typeof Promise !== 'undefined' && promise instanceof Promise) {
            promise.then(function() {
                if (d) {
                    console.debug('Playing, current time: %s, duration: %s',
                        secondsToTime(video.currentTime),
                        secondsToTime(video.duration));
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
};

Streamer.prototype.on = function(ev, success, error) {
    success = tryCatch(success.bind(this), error);

    if (this.evs[ev]) {
        this.evs[ev].push(success);
    }
    else {
        this.evs[ev] = [success];
    }

    return this;
};

Streamer.prototype.getImage = function(w, h) {
    var self = this;
    var video = this.video;

    return new Promise(function _(resolve, reject) {
        if (!video.videoWidth) {
            return reject(-9);
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

            if (video.paused) {
                reject(-5);
            }
            else if (video.ended) {
                reject(-8);
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
                video.currentTime = 20 * video.duration / 100;
                return true;
            }

            s.getImage().then(_resolve).catch(_reject);
        });

        s.on('error', _reject);
    });
};

/**
 *  @global
 *  @preserve
 *  @name Streamer
 */
Object.defineProperty(self, 'Streamer', {
    value: Object.freeze(Streamer)
});
