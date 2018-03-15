'use strict';

var inherits = require('inherits');
var Buffer = require('buffer').Buffer;
var stream = require('readable-stream');
var EventEmitter = require('events').EventEmitter;
var EBMLDecoder = require('ebml/lib/ebml/decoder');

module.exports = EBMLRemuxer;

if (d > 99) {
    var tmp = function EBMLDecoder() {
        this.$etup();
    };

    createStream(tmp, EBMLDecoder);
    EBMLDecoder = tmp;
}

/**
 * Receives raw data and sends back webm media segments.
 * @param {Object} file The file instance to get raw data from
 * @constructor
 */
function EBMLRemuxer(file) {
    var self = this;
    this.$etup();

    this._file = file;
    this._tracks = [];
    this._seekTime = -1;
    this._hasVideo = false;
    this._hasAudio = false;
    this._seekTable = false;
    this._seekTimeFixup = -1;
    this._initSegment = false;

    this._createReader(0, 'segment', function(segment) {
        this.destroy();
        self.setInitSegment(segment);
    });
}

createStream(EBMLRemuxer, EventEmitter);

EBMLRemuxer.prototype.emitInitSegment = function(segment) {
    var tracks = segment.Tracks;

    if (d) {
        console.log('initSegment', segment, [this]);
    }

    if (!tracks) {
        return this.destroy(new Error('Unsupported media format.'));
    }

    var getCodec = function(codec) {
        return String(codec).substr(2).toLowerCase();
    };
    var getMime = function(codec, type) {
        switch (codec) {
            case 'A_VORBIS':
            case 'A_OPUS':
            case 'V_VP8':
            case 'V_VP9':
                return (type === 1 ? 'video' : 'audio') + '/webm; codecs="' + getCodec(codec) + '"';
        }
    };

    for (var i = tracks.length; i--;) {
        var track = tracks[i];
        var codec = track.CodecID;
        var type = track.TrackType;
        var mime = getMime(codec, type);

        if (d) {
            console.debug('Track%s, %s, %s', track.TrackNumber, codec, mime, track);
        }

        if (!mime) {
            continue;
        }

        if (!this._hasVideo && type === 1) {
            this._hasVideo = codec;
        }
        else if (!this._hasAudio && type === 2) {
            if (MediaSource.isTypeSupported(mime)) {
                this._hasAudio = codec;
            }
            else {
                if (d) {
                    console.debug('Unsupported audio track.', mime);
                }
                continue;
            }
        }
        else {
            continue;
        }

        track.mime = mime;
    }

    if (this._hasVideo) {
        var mime = 'video/webm; codecs="' + getCodec(this._hasVideo);

        if (this._hasAudio) {
            mime += ',' + getCodec(this._hasAudio);
        }

        this._tracks.push({mime: mime + '"'});
    }
    else if (this._hasAudio) {
        this._tracks.push({mime: 'audio/webm; codecs="' + getCodec(this._hasAudio) + '"'});
    }

    if (!this._tracks.length) {
        return this.destroy(new Error('no playable tracks'));
    }

    if (segment.Cues) {
        this._shrink(segment, {Cues: 'CuePoint'});

        var c = segment.Cues;
        var y = segment.playtime;
        var t = this._seekTable = [];

        for (var j = c.length; j--;) {
            var p = c[j];
            var x = p.CueTrackPositions;
            var z = Math.round((p.CueTime * segment.timescale) * 1000) / 1000;

            t.push([z, y, x.CueClusterPosition + segment.offset]);
            y = z;
        }
    }

    var data = this._tracks.map(function(track) {
        return {
            mime: track.mime,
            init: segment.data
        };
    });

    this._initSegment = segment;
    this.emit('ready', data);
};

EBMLRemuxer.prototype._shrink = function(segment, props) {
    for (var k in props) {
        if (segment[k] && (segment[k] = segment[k][props[k]])) {
            if (!Array.isArray(segment[k])) {
                segment[k] = [segment[k]];
            }
        }
    }
};

EBMLRemuxer.prototype._createReader = function(offset, target, event, cb) {
    var self = this;
    var reader = new EBMLReader(self._file, offset);

    if (typeof target === 'string') {
        cb = event;
        event = target;
        target = self;
    }

    reader.on(event, function() {
        cb.apply(reader, arguments);
    });

    reader.on('error', function(err) {
        target.destroy(err);
    });

    return reader;
};

EBMLRemuxer.prototype.setInitSegment = function(segment) {
    var self = this;
    var info = segment.Info;
    if (info) {
        segment.timescale = info.TimecodeScale / 1e9;
        segment.playtime = info.Duration * segment.timescale;
    }
    this._shrink(segment, {'Tracks': 'TrackEntry', 'SeekHead': 'Seek', 'Tags': 'Tag'});

    if (!segment.Cues && segment.SeekHead) {
        var cuesOffset = -1;

        for (var i = segment.SeekHead.length; i--;) {
            var seekHead = segment.SeekHead[i];

            if (seekHead.SeekID.readInt32BE() === 0x1c53bb6b) {
                cuesOffset = seekHead.SeekPosition + segment.offset;
                break;
            }
        }

        if (cuesOffset > 0) {
            this._createReader(cuesOffset, 'cues', function(chunk) {
                segment.Cues = chunk.Cues;
                self.emitInitSegment(segment);
                this.destroy();
            });
            return;
        }
    }

    this.emitInitSegment(segment);
};

EBMLRemuxer.prototype._findCluster = function(time) {
    var offset = 0;
    var t = this._seekTable;
    this._seekTime = time = Math.round(time * 1000) / 1000;

    for (var i = 0; i < t.length; ++i) {
        var x = t[i][0];
        var y = t[i][1];
        var z = t[i][2];

        if (time >= x && time <= y) {
            time = x;
            offset = t[i + 1] ? t[i + 1][2] : z;
            break;
        }
    }

    this._seekTimeFixup = time;
    return offset || this._initSegment.data.length;
};

EBMLRemuxer.prototype.seek = function(time) {
    var self = this;
    var offset = self._findCluster(time);

    // console.warn('ebml:seek', time, offset, [this]);

    return self._tracks.map(function(track, i) {
        if (track.outStream) {
            track.outStream.destroy();
        }
        return track.outStream = new MediaSegment(self, offset);
    });
};

// @private
function EBMLReader(file, offset) {
    this.$etup();

    this._file = file;
    this._conGroup = 0;
    this._cluster = null;
    this._ebmlOffset = 0;
    this._clusterCount = 0;
    this._segmentOffset = 0;
    this._timecodes = [0, 0];
    this._byteOffset = offset;
    this._trackDefaultDuration = 0;
    this._segment = Object.create(null);

    this.$buffer = new Buffer(0x2000000);
    this.$head = 0;

    this._decoder = new EBMLDecoder();
    this._fileStream = file.createReadStream({start: offset});
    this._fileStream.pipe(this);

    var self = this;
    this._decoder.on('data', function(chunk) {
        self._onData(chunk[0], chunk[1]);
    });

    this.on('finish', function() {
        self._onFinish();
    });
}

createStream(EBMLReader, stream.Writable, function() {
    if (this._fileStream) {
        this._fileStream.destroy();
        this._fileStream = null;
    }
    if (this._decoder) {
        this._decoder.end();
        this._decoder.destroy();
        this._decoder = null;
    }
    this.$buffer = null;
    this._cluster = null;

    while (this._conGroup-- > 0) {
        console.groupEnd();
    }
});

EBMLReader.prototype._getValue = function(chunk) {
    // https://www.matroska.org/technical/specs/index.html
    var data = chunk.data;
    if (chunk.type === 'b') {
        return data;
    }
    if (chunk.type === 's') {
        return data.toString('ascii');
    }
    if (chunk.type === '8') {
        return data.toString('utf-8');
    }
    if (chunk.type === 'f') {
        return chunk.dataSize < 8 ? data.readFloatBE() : data.readDoubleBE();
    }

    var value = 0;
    for (var i = 0; i < chunk.dataSize; i++) {
        value |= data[i] << 8 * (chunk.dataSize - i - 1);
    }
    return value;
};

EBMLReader.prototype._emitCluster = function(duration) {
    var h = ~this._clusterCount & 1;
    var timecode = this._timecodes[h];
    this.emit('cluster', this._cluster, timecode, duration);
    this._cluster = null;
};

EBMLReader.prototype._onFinish = function() {
    if (this._cluster !== null) {
        this._emitCluster(-1);
    }
    this.emit('cluster', null);
    this.destroy();
};

EBMLReader.prototype._onData = function(state, data) {
    var tmp;

    if (d > 2 && data.name !== 'SimpleBlock') {
        if (state === 'start') {
            this._conGroup++;
            console.group(data.name);
        }

        console.log('state=%s, data=%s', state, data.name, state === 'tag' && [this._getValue(data)], data);

        if (state === 'end') {
            this._conGroup--;
            console.groupEnd();
        }
    }

    if (state === 'start') {
        if (!this._byteOffset) {
            // Retrieving initialization segment.

            if (data.name === 'EBML') {
                this._ebmlOffset = data.start;
            }
            else if (data.name === 'Segment') {
                this._segmentOffset = -1;
            }
            else if (this._segmentOffset < 0) {
                this._segmentOffset = data.start;
            }
            else if (data.name === 'Cluster') {
                var segment = this._segment;
                this._segment = false;

                delete segment.$;
                segment.offset = this._segmentOffset;
                segment.data = this._read(this._ebmlOffset, data.start);

                var dd = this._trackDefaultDuration;
                if (dd) {
                    if (d) {
                        console.debug('Cleaning DefaultDuration...\n' + hexdump(segment.data, dd.start).slice(0, 4).join('\n'));
                    }

                    var size = dd.dataSize;
                    if (size > 4) {
                        console.warn('Unexpected default duration...', dd);
                    }
                    else {
                        segment.data.writeUInt32BE(0x25868880 + size, dd.start);

                        while (size-- > 0) {
                            segment.data.writeUInt8(0x20, 4 + dd.start + size);
                        }
                    }
                }

                this.emit('segment', segment);
                return;
            }
        }

        if (data.name === 'Cues' && this._cluster !== null) {
            return this._onFinish();
        }

        tmp = Object.create(null);
        tmp.$ = this._segment;

        if (this._segment[data.name]) {
            if (Array.isArray(this._segment[data.name])) {
                this._segment[data.name].push(tmp);
            }
            else {
                this._segment[data.name] = [this._segment[data.name], tmp];
            }
        }
        else {
            this._segment[data.name] = tmp;
        }
        this._segment = tmp;
    }
    else if (state === 'end') {
        tmp = this._segment;
        this._segment = tmp.$;
        delete tmp.$;

        if (data.end - data.start > 0) {
            var name = data.name.toLowerCase();

            if (this.listenerCount(name)) {
                var chunk = this._read(data.start, data.end);

                if (name === 'cluster') {
                    this._cluster = chunk;
                }
                else {
                    if (name === 'cues') {
                        tmp = this._segment;
                        tmp.data = chunk;
                        chunk = tmp;
                    }
                    this.emit(name, chunk);
                }
            }
        }
        else {
            console.warn('Empty master element...', data);
        }
    }
    else {
        this._segment[data.name] = this._getValue(data);

        if (data.name === 'Timecode') {
            var h = ++this._clusterCount & 1;

            this._timecodes[h] = this._getValue(data);

            if (this._cluster !== null) {
                this._emitCluster(this._timecodes[h] - this._timecodes[~h & 1]);
            }
        }
        else if (data.name === 'DefaultDuration') {
            this._trackDefaultDuration = data;
        }
    }
};

EBMLReader.prototype._read = function(start, end) {
    var length = end - start;
    var buffer = new Buffer(length);
    var offset = start % this.$buffer.length;
    var left = this.$buffer.length - offset;

    // console.warn('ebml:read', arguments);

    if (length > this.$buffer.length) {
        this.destroy(new Error('ebml:read buffer overflow.'));
    }
    else if (length > left) {
        this.$buffer.copy(buffer, 0, offset, this.$buffer.length);
        this.$buffer.copy(buffer, left, 0, length - left);
    }
    else {
        this.$buffer.copy(buffer, 0, offset, offset + length);
    }

    return buffer;
};

EBMLReader.prototype._write = function(chunk, enc, cb) {
    if (chunk.length > this.$buffer.length) {
        return this.destroy(new Error('ebml:write buffer overflow.'));
    }

    // console.warn('ebml:write', arguments);

    var left = this.$buffer.length - this.$head;
    if (chunk.length > left) {
        chunk.copy(this.$buffer, this.$head, 0, left);
        chunk.copy(this.$buffer, 0, left, chunk.length);
        this.$head = (chunk.length - left);
    }
    else {
        chunk.copy(this.$buffer, this.$head);
        this.$head += chunk.length;
    }

    try {
        this._decoder.write(chunk);
        cb();
    }
    catch (ex) {
        this.destroy(ex);
    }
};

// @private
function MediaSegment(muxer, offset) {
    var self = this;
    this.$etup();

    var s = muxer._initSegment;
    this.playtime = s.playtime;
    this.timescale = s.timescale;
    this.seektime = muxer._seekTime;
    this._reader = null;

    this._async(function() {
        self._reader = muxer._createReader(offset, self, 'cluster', function(cluster) {
            if (!self.destroyed) {
                if (cluster) {
                    self.append.apply(self, arguments);
                }
                else {
                    if (d > 1) {
                        console.debug(self + ' EOS', cluster === null);
                    }
                    self.push(null);
                    self.destroy();
                }
            }
        });
    });
}

createStream(MediaSegment, stream.PassThrough, function(err) {
    if (this._reader) {
        this._reader.destroy(err);
        this._reader = null;
    }
    this.end();
});

MediaSegment.prototype.hexdump = function(data) {
    var h = hexdump(data);
    console.log(h.slice(0, 12).join('\n') + '\n........\n' + h.slice(h.length - 4).join('\n'));
};

MediaSegment.prototype.append = function(cluster, timecode, duration) {
    // this.hexdump(cluster);

    if (duration < 0) {
        duration = this.playtime / this.timescale - timecode;

        if (d) {
            console.debug(this + ' Last cluster, duration:', duration);
        }
    }

    var timecodeOffset = -1;
    var cs = cluster.readUInt32BE(4);

    if (cs === 0x1000000) {
        timecodeOffset = 12;
    }
    else if ((cs >> 24) === 0xFF) {
        timecodeOffset = 5;
    }
    else if (d) {
        console.warn('Unexpected cluster data size...');
        this.hexdump(cluster);
    }

    if (timecodeOffset > 0) {
        cs = cluster.readUInt16BE(timecodeOffset);
        if ((cs >> 8) === 0xE7 && (cs & 0xff) > 0x7F) {
            // cluster.timecode = timecode * this.timescale;
            cluster.duration = 1;//duration * this.timescale;

            if (this.seektime !== -1) {
                cluster.seektime = this.seektime;
                this.seektime = -1;
            }

            var len = cs & ~0xFF80;
            var offset = timecodeOffset + 2;

            while (len-- > 0) {
                cluster.writeUInt8(0, offset++);
            }
        }
        else if (d) {
            console.warn('Unexpected timecode offset...');
        }
    }

    this.push(cluster);
};

// @private
function createStream(dest, source, destroy) {
    inherits(dest, source);

    dest.prototype.$etup = function() {
        var self = this;

        self.$iid = (Math.random() * Date.now() | 0).toString(16).slice(-6);
        self.destroyed = false;
        source.call(self);

        if (d > 2) {
            var _emit = this.emit;
            this.emit = function(event) {
                console.warn(this + '.emit(%s)', event, arguments, [this]);
                return _emit.apply(this, arguments);
            };
        }
    };

    dest.prototype._async = function(cb) {
        var self = this;
        onIdle(function() {
            if (!self.destroyed) {
                cb.call(self);
            }
        });
    };

    destroy = destroy && tryCatch(destroy);
    dest.prototype.destroy = function(err) {
        if (d) {
            var fn = err ? 'error' : 'debug';
            console[fn](this + '.destroy', this.destroyed, [this], err);
        }

        if (!this.destroyed) {
            this.destroyed = true;

            if (destroy) {
                destroy.call(this, err);
            }

            if (err) {
                this.emit('error', err);
            }
            this.emit('close');
        }
    };

    dest.prototype.toString = function() {
        return this.constructor.name + '[$' + this.$iid + ']';
    };
}

// @private
function tryCatch(cb) {
    cb.$trycatcher = function() {
        try {
            return cb.apply(this, arguments);
        }
        catch (ex) {
            console.warn('Unexpected caught exception.', ex);
        }
    };
    return cb.$trycatcher;
}

// @private
function hexdump(buffer, offset, length) {
    offset = offset || 0;
    length = length || buffer.length;

    var out = [];
    var row = "";
    for (var i = 0; i < length; i += 16) {
        row = ('0000000' + offset.toString(16).toUpperCase()).slice(-8) + ":  ";
        var n = Math.min(16, length - offset);
        var string = "";
        for (var j = 0; j < 16; ++j) {
            if (j && !(j % 4)) {
                row += " ";
            }
            if (j < n) {
                var value = buffer.readUInt8(offset);
                string += value > 0x1f && value < 0x7f ? String.fromCharCode(value) : ".";
                row += ("0" + value.toString(16).toUpperCase()).slice(-2);
                offset++;
            }
            else {
                row += "  ";
                string += " ";
            }
        }
        out.push(row + "  " + string);
    }
    return out;
}
