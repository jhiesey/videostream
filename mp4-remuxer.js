var bs = require('binary-search')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var mp4 = require('mp4-stream')
var Box = require('mp4-box-encoding')
var RangeSliceStream = require('range-slice-stream')
var Buffer = require('buffer').Buffer
var locale = require('./bundle/locale');

// if we want to ignore more than this many bytes, request a new stream.
// if we want to ignore fewer, just skip them.
var FIND_MOOV_SEEK_SIZE = 4096;

module.exports = MP4Remuxer

function MP4Remuxer (file) {
	var self = this
	EventEmitter.call(self)
	self._tracks = []
	self._file = file
	self._decoder = null
	self._findMoov(0)
}

inherits(MP4Remuxer, EventEmitter)

MP4Remuxer.prototype._parseMoov = function() {
    var self = this;
    var moov = self._moov;
    var sidx = self._sidx;

    if (!moov) {
        return;
    }
    self._moov = self._sidx = false;

    if (self._decoder) {
        self._decoder.destroy()
    }

    try {
        if (sidx) {
            for (var i = moov.traks.length; i--;) {
                var trak = moov.traks[i];
                if (trak.tkhd.trackId === sidx.referenceId) {
                    trak.sidx = sidx;
                    break;
                }
            }
        }
        self._processMoov(moov);
    }
    catch (err) {
        self.emit('error', err);
    }
};

MP4Remuxer.prototype._findMoov = function(offset) {
    var self = this;
    var file = this._file;
    var boxes = {'moov': 1, 'sidx': 1};
    var lastbox = 'sidx';

    if (!(d > 11)) {
        lastbox = 'moov';
        delete boxes.sidx;
    }

    if (file.filesize >= 0 && offset >= file.filesize) {
        if (self._moov) {
            return self._parseMoov();
        }
        return self.emit('error', RangeError('Offset out of bound.'));
    }

    var fileStream = file.createReadStream({start: offset});
    self._decoder = mp4.decode();
    fileStream.pipe(self._decoder);

    var toSkip = 0;
    var boxHandler = function(headers) {
        var destroy = function() {
            fileStream.destroy();
            self._decoder.removeListener('box', boxHandler);
            self._decoder.destroy();
        };
        var findNextBox = function() {
            if (self['_' + lastbox]) {
                destroy();
                self._parseMoov();
            }
            else if (headers.length < FIND_MOOV_SEEK_SIZE) {
                toSkip += headers.length;
                self._decoder.ignore()
            }
            else {
                destroy();
                toSkip += headers.length;
                self._findMoov(offset + toSkip);
            }
        };

        if (d) {
            console.debug('box', headers.type, headers.length, headers, offset);
        }

        if (boxes[headers.type]) {
            self._decoder.decode(function(data) {
                self['_' + headers.type] = data;
                findNextBox();
            });
        }
        else {
            findNextBox();
        }
    };
    self._decoder.on('box', boxHandler);
};

function RunLengthIndex (entries, countName) {
	var self = this
	self._entries = entries
	self._countName = countName || 'count'
	self._index = 0
	self._offset = 0

	self.value = self._entries[0] || false;
}

RunLengthIndex.prototype.inc = function () {
	var self = this
	self._offset++
	if (self._offset >= self._entries[self._index][self._countName]) {
		self._index++
		self._offset = 0
	}

	self.value = self._entries[self._index] || false;
}

MP4Remuxer.prototype._processTracks = function(traks) {
    var self = this;
    var mime, codec, audio = [];
    var hevc = Object.assign(Object.create(null), {'hvc1': 1, 'hev1': 1});
    var vide = Object.assign(Object.create(null), {'avc1': 1, 'av01': 1}, hevc);
    var mp3a = Object.assign(Object.create(null), {'mp4a.6b': 1, 'mp4a.69': 1});

    var validateAudioTrack = function(trk) {
        if (!trk) {
            return false;
        }

        var mime = trk.mime;
        if (!MediaSource.isTypeSupported(mime)) {
            if (trk.codec !== 'mp3' || !MediaSource.isTypeSupported(mime = 'audio/mpeg')) {
                // Let's continue without audio if actually unsupported, e.g. mp4a.6B (MP3)
                self._hasUnsupportedAudio = trk.codec;
                return false;
            }
            trk.mime = mime;
        }

        if (self._hasVideo && hevc[self._hasVideo.type]) {
            mime = self._hasVideo.mime.replace(/"$/, ', ' + trk.codec + '"');

            // @todo DTS (aka mp4a.a9 (dca)) if supposed to work..
            if (trk.codec === 'mp4a.a9' || !MediaSource.isTypeSupported(mime)) {
                if (d) {
                    console.warn('[hevc] unsupported audio track.', mime);
                }
                self._hasUnsupportedAudio = self._hasVideo.type + ':' + trk.codec;
                return false;
            }
        }

        return trk;
    };

    for (var i = 0; i < traks.length; i++) {
        var trak = traks[i];
        var mdia = trak.mdia || false;
        var stbl = trak.mdia.minf.stbl;
        var stsd = stbl.stsd.entries[0];
        var lang = Object(mdia.mdhd).language;
        var type = Object(mdia.hdlr).handlerType;

        if (type === 'vide' && vide[stsd.type]) {
            codec = stsd.type;
            if (stsd.avcC) {
                codec += '.' + stsd.avcC.mimeCodec
            }
            else if (stsd.av1C) {
                codec = stsd.av1C.mimeCodec || codec;
            }
            else if (stsd.hvcC) {
                codec += stsd.hvcC.mimeCodec;
            }

            mime = 'video/mp4; codecs="' + codec + '"';
            if (d) {
                console.debug('Track%d: %s %s', i, locale.decodeMP4LangCode(lang), mime);
            }

            if (!self._hasVideo) {
                self._hasVideo = {type: stsd.type, codec: codec, mime: mime, trak: trak, lang: lang, idx: i};
            }
        }
        else if (type === 'soun') {
            codec = stsd.type;

            if (stsd.type === 'mp4a') {
                codec = 'mp4a';

                if (stsd.esds && stsd.esds.mimeCodec) {
                    codec += '.' + stsd.esds.mimeCodec
                }

                if (mp3a[codec]) {
                    // Firefox allows mp3 in mp4 this way
                    codec = 'mp3'
                }
            }
            else if (stsd.type === 'fLaC') {
                codec = 'flac';
            }

            mime = 'audio/mp4; codecs="' + codec + '"';
            if (d) {
                console.debug('Track%d: %s %s', i, locale.decodeMP4LangCode(lang), mime);
            }

            audio.push({type: stsd.type, codec: codec, mime: mime, trak: trak, lang: lang, idx: i});
        }
    }

    if (audio.length < 2) {
        self._hasAudio = validateAudioTrack(audio[0]);
        return;
    }

    var eng, def, und;
    for (var j = 0; j < audio.length; ++j) {
        var trk = validateAudioTrack(audio[j]);
        if (trk) {
            var lng = locale.decodeMP4LangCode(trk.lang);

            if (!eng && lng === 'eng') {
                eng = trk;
            }

            if (!def && locale.bcp47match(lng)) {
                def = trk;
            }

            und = und || trk;
        }
    }

    self._hasAudio = def || eng || und;
};

MP4Remuxer.prototype._processMoov = function (moov) {
	var self = this
	var traks = moov.traks || false;

	if (moov.otherBoxes) {
		for (var b = moov.otherBoxes.length; b--;) {
			if (moov.otherBoxes[b] instanceof Error) {
				self.emit('error', moov.otherBoxes[b]);
				return;
			}
		}
	}

	self._tracks = []
	self._hasVideo = false
	self._hasAudio = false
	self._processTracks(traks);
	if (d) {
		console.debug('video%s:%s, audio%s:%s', self._hasVideo.idx, self._hasVideo.codec, self._hasAudio.idx, self._hasAudio.codec);
	}

	for (var i = 0; i < traks.length; i++) {
		var trak = traks[i]
		var stbl = trak.mdia.minf.stbl
		var stco = stbl.stco || stbl.co64;
		var stsdEntry = stbl.stsd.entries[0]
		var handlerType = trak.mdia.hdlr.handlerType
		var mime
        if (d) {
            console.debug('handler=%s, type=%s, trak:', handlerType, stsdEntry.type, trak);
        }
        if (self._hasVideo && self._hasVideo.trak === trak) {
            mime = self._hasVideo.mime;
            self._hasVideo = self._hasVideo.codec;
        }
        else if (self._hasAudio && self._hasAudio.trak === trak) {
            mime = self._hasAudio.mime;
            self._hasAudio = self._hasAudio.codec;
        }
        else {
            continue
        }

		var samples = []
		var sample = 0

		// Chunk/position data
		var sampleInChunk = 0
		var chunk = 0
		var offsetInChunk = 0
		var sampleToChunkIndex = 0
        var currChunkEntry;

		// Time data
		var dts = 0
		var decodingTimeEntry = new RunLengthIndex(stbl.stts.entries)
		var presentationOffsetEntry = null
		if (stbl.ctts) {
			presentationOffsetEntry = new RunLengthIndex(stbl.ctts.entries)
		}

		// Sync table index
		var syncSampleIndex = 0

        if (!decodingTimeEntry.value) {
            console.warn("No 'stts' entries for trak %s...", i, trak);
            continue;
        }

        while (true) {
            currChunkEntry = stbl.stsc.entries[sampleToChunkIndex]

			// Compute size
			var size = stbl.stsz.sample_size || stbl.stsz.entries[sample];

			// Compute time data
			var duration = decodingTimeEntry.value && decodingTimeEntry.value.duration || 0;
			var presentationOffset = presentationOffsetEntry && presentationOffsetEntry.value.compositionOffset || 0;

			// Compute sync
			var sync = true
			if (stbl.stss) {
				sync = stbl.stss.entries[syncSampleIndex] === sample + 1
			}

			// Create new sample entry
			samples.push({
				size: size,
				duration: duration,
				dts: dts,
				presentationOffset: presentationOffset,
				sync: sync,
				offset: offsetInChunk + stco.entries[chunk]
			})

			// Go to next sample
			sample++
			if (sample >= stbl.stsz.sample_count) {
				break
			}

			// Move position/chunk
			sampleInChunk++
			offsetInChunk += size
			if (sampleInChunk >= currChunkEntry.samplesPerChunk) {
				// Move to new chunk
				sampleInChunk = 0
				offsetInChunk = 0
				chunk++
				// Move sample to chunk box index
				var nextChunkEntry = stbl.stsc.entries[sampleToChunkIndex + 1]
				if (nextChunkEntry && chunk + 1 >= nextChunkEntry.firstChunk) {
					sampleToChunkIndex++
				}
			}

			// Move time forward
			dts += duration
			decodingTimeEntry.inc()
			presentationOffsetEntry && presentationOffsetEntry.inc()

			// Move sync table index
			if (sync) {
				syncSampleIndex++
			}
		}

		trak.mdia.mdhd.duration = 0
		trak.tkhd.duration = 0

        var defaultSampleDescriptionIndex = currChunkEntry && currChunkEntry.sampleDescriptionId || 0;

		var trackMoov = {
			type: 'moov',
			mvhd: moov.mvhd,
			traks: [{
				tkhd: trak.tkhd,
				mdia: {
					mdhd: trak.mdia.mdhd,
					hdlr: trak.mdia.hdlr,
					elng: trak.mdia.elng,
					minf: {
						vmhd: trak.mdia.minf.vmhd,
						smhd: trak.mdia.minf.smhd,
						dinf: trak.mdia.minf.dinf,
						stbl: {
							stsd: stbl.stsd,
							stts: empty(),
							ctts: empty(),
							stsc: empty(),
							stsz: empty(),
							stco: empty(),
							stss: empty()
						}
					}
				}
			}],
			mvex: {
				mehd: {
					fragmentDuration: moov.mvhd.duration
				},
				trexs: [{
					trackId: trak.tkhd.trackId,
					defaultSampleDescriptionIndex: defaultSampleDescriptionIndex,
					defaultSampleDuration: 0,
					defaultSampleSize: 0,
					defaultSampleFlags: 0
				}]
			}
		}

		self._tracks.push({
			fragmentSequence: 1,
			trackId: trak.tkhd.trackId,
			timeScale: trak.mdia.mdhd.timeScale,
			samples: samples,
			currSample: null,
			currTime: null,
			moov: trackMoov,
			mime: mime
		})
	}

	if (self._tracks.length === 0) {
		self.emit('error', new Error('no playable tracks'))
		return
	}

	// Must be set last since this is used above
	moov.mvhd.duration = 0

	self._ftyp = {
		type: 'ftyp',
		brand: 'iso5',
		brandVersion: 0,
		compatibleBrands: [
			'iso5'
		]
	}

	var ftypBuf = Box.encode(self._ftyp)
	var data = self._tracks.map(function (track) {
		var moovBuf = Box.encode(track.moov)
		return {
			mime: track.mime,
			init: Buffer.concat([ftypBuf, moovBuf])
		}
	})

	self.emit('ready', data)
}

function empty () {
	return {
		version: 0,
		flags: 0,
		entries: []
	}
}

MP4Remuxer.prototype._writeFragment = function(fragment, i) {
    var self = this;
    var track = self._tracks[i];
    var inStream = track.inStream;
    var outStream = track.outStream;

    var wrap = function(cb) {
        return function(err) {
            if (err) {
                self.emit('error', err)
            }
            else if (outStream.destroyed || inStream.destroyed) {
                if (d > 1) {
                    console.debug('writeFragment stream destroyed', outStream.destroyed, inStream.destroyed);
                }
            }
            else {
                cb();
            }
        };
    };

    var parser = wrap(function() {
        fragment = self._generateFragment(i);
        if (!fragment) {
            return outStream.finalize()
        }
        writeFragment();
    });
    var boxer = wrap(function() {
        var slicedStream = inStream.slice(fragment.ranges);
        var mediaDataStream = outStream.mediaData(fragment.length, parser);
        slicedStream.pipe(mediaDataStream);
    });
    var writeFragment = function() {
        if (!outStream.destroyed) {
            outStream.box(fragment.moof, boxer);
        }
    };
    writeFragment();
};

MP4Remuxer.prototype.seek = function (time) {
	var self = this
	if (!self._tracks) {
		throw new Error('Not ready yet; wait for \'ready\' event')
	}

	if (self._fileStream) {
		self._fileStream.destroy()
		self._fileStream = null
	}

    var highWaterMark = 0;
    var startOffset = Math.pow(2, 53);
    self._tracks.forEach(function(track, i) {
        track.fragment = self._generateFragment(i, time);
        if (track.fragment) {
            var rangeStart = track.fragment.ranges[0].start;
            startOffset = Math.min(startOffset, rangeStart);

            if (!highWaterMark) {
                highWaterMark = rangeStart;
            }
            else {
                highWaterMark = Math.abs(highWaterMark - rangeStart);
            }
        }
    });

    if (d) {
        console.debug('MP4Remuxer: Measured highWaterMark to need %s bytes.', highWaterMark);

        if (highWaterMark > 1e7) {
            // XXX: Check whether we should rather maintain two independent "fileStream"s...
            console.warn('^ excessive highWaterMark detected...');
        }
    }
    highWaterMark = Math.min(((highWaterMark + 0x1000000) & -0x1000000) >>> 0, Math.pow(2,26) * self._tracks.length);

    return self._tracks.map(function(track, i) {
		// find the keyframe before the time
		// stream from there
		if (track.outStream) {
			track.outStream.destroy()
		}
		if (track.inStream) {
			track.inStream.destroy()
			track.inStream = null
		}
        track.outStream = mp4.encode();
        if (!track.fragment) {
            track.outStream.finalize();
        }
        else {
            if (d) {
                console.debug('MP4Remuxer.seek(%s)', time, track, startOffset);
            }

            track.inStream = new RangeSliceStream(startOffset, {
                // Allow up to a 10MB offset between audio and video,
                // which should be fine for any reasonable interleaving
                // interval and bitrate
                highWaterMark: highWaterMark
            });

            if (!self._fileStream) {
                self._fileStream = self._file.createReadStream({start: startOffset});
            }
            self._fileStream.pipe(track.inStream);
            self._writeFragment(track.fragment, i);
        }

        return track.outStream;
    });
};

MP4Remuxer.prototype._findSampleBefore = function(trackId, time) {
	var self = this

    var track = self._tracks[trackId]
	var scaledTime = Math.floor(track.timeScale * time)
	var sample = bs(track.samples, scaledTime, function (sample, t) {
		var pts = sample.dts + sample.presentationOffset// - track.editShift
		return pts - t
	})
	if (sample === -1) {
		sample = 0
	} else if (sample < 0) {
		sample = -sample - 2
	}
	if (sample < 1) return 0
	// sample is now the last sample with dts <= time
    // Find the preceding sync sample
    var sampleIdx = sample;
	while (!track.samples[sample].sync) {
        if (--sample < 0) {
            return sampleIdx;
        }
    }
	return sample
}

var MIN_FRAGMENT_DURATION = 1 // second

MP4Remuxer.prototype._generateFragment = function (track, time) {
	var self = this
	/*
	1. Find correct sample
	2. Process backward until sync sample found
	3. Process forward until next sync sample after MIN_FRAGMENT_DURATION found
	*/
	var currTrack = self._tracks[track]
	var firstSample
	if (time !== undefined) {
		firstSample = self._findSampleBefore(track, time)
	} else {
		firstSample = currTrack.currSample
	}

	if (firstSample >= currTrack.samples.length)
		return null

	var startDts = currTrack.samples[firstSample].dts

	var totalLen = 0
	var ranges = []
	for (var currSample = firstSample; currSample < currTrack.samples.length; currSample++) {
		var sample = currTrack.samples[currSample]
		if (sample.sync && sample.dts - startDts >= currTrack.timeScale * MIN_FRAGMENT_DURATION) {
			break // This is a reasonable place to end the fragment
		}

		totalLen += sample.size
		var currRange = ranges.length - 1
		if (currRange < 0 || ranges[currRange].end !== sample.offset) {
			// Push a new range
			ranges.push({
				start: sample.offset,
				end: sample.offset + sample.size
			})
		} else {
			ranges[currRange].end += sample.size
		}
	}

	currTrack.currSample = currSample

	return {
		moof: self._generateMoof(track, firstSample, currSample),
		ranges: ranges,
		length: totalLen
	}
}

MP4Remuxer.prototype._generateMoof = function (track, firstSample, lastSample) {
	var self = this

	var currTrack = self._tracks[track]

	var entries = []
	var trunVersion = 0
	for (var j = firstSample; j < lastSample; j++) {
		var currSample = currTrack.samples[j]
		if (currSample.presentationOffset < 0)
			trunVersion = 1
		entries.push({
			sampleDuration: currSample.duration,
			sampleSize: currSample.size,
			sampleFlags: currSample.sync ? 0x2000000 : 0x1010000,
			sampleCompositionTimeOffset: currSample.presentationOffset
		})
	}

	var moof = {
		type: 'moof',
		mfhd: {
			sequenceNumber: currTrack.fragmentSequence++
		},
		trafs: [{
			tfhd: {
				flags: 0x20000, // default-base-is-moof
				trackId: currTrack.trackId
			},
			tfdt: {
				baseMediaDecodeTime: currTrack.samples[firstSample].dts
			},
			trun: {
				flags: 0xf01,
				dataOffset: 8, // The moof size has to be added to this later as well
				entries: entries,
				version: trunVersion
			}
		}]
	}

	// Update the offset
	moof.trafs[0].trun.dataOffset += Box.encodingLength(moof)

	return moof
}

// Extending mp4-box-encoding boxes support...

var UINT32_MAX = Math.pow(2, 32);

Box.boxes.fullBoxes.co64 = true;
Box.boxes.co64 = Box.boxes.co64 || {};
Box.boxes.co64.decode = function(buf, offset) {
    buf = buf.slice(offset);
    var num = buf.readUInt32BE(0);
    var entries = new Array(num);

    for (var i = 0; i < num; i++) {
        var pos = i * 8 + 4;
        var hi = buf.readUInt32BE(pos);
        var lo = buf.readUInt32BE(pos + 4);
        entries[i] = (hi * UINT32_MAX) + lo;
    }

    return {
        entries: entries
    }
};

Box.boxes.av1C = {};
Box.boxes.av1C.encode = function _(box, buf, offset) {
    buf = buf ? buf.slice(offset) : Buffer.allocUnsafe(box.buffer.length);
    box.buffer.copy(buf);
    _.bytes = box.buffer.length;
};
Box.boxes.av1C.decode = function (buf, offset, end) {
    // https://aomediacodec.github.io/av1-isobmff/#codecsparam
    var p = 0;
    var r = Object.create(null);
    var readUint8 = function() {
        return buf.readUInt8(p++);
    };
    buf = buf.slice(offset, end);

    var tmp = readUint8();
    this.version = tmp & 0x7F;

    if ((tmp >> 7) & 1 !== 1) {
        console.warn('Invalid av1C marker.');
    }
    else if (this.version !== 1) {
        console.warn('Unsupported av1C version %d.', this.version);
    }
    else {
        tmp = readUint8();
        r.seq_profile = (tmp >> 5) & 7;
        r.seq_level_idx_0 = tmp & 0x1f;
        tmp = readUint8();
        r.seq_tier_0 = (tmp >> 7) & 1;
        r.high_bitdepth = (tmp >> 6) & 1;
        r.twelve_bit = (tmp >> 5) & 1;
        r.monochrome = (tmp >> 4) & 1;
        r.chroma_subsampling_x = (tmp >> 3) & 1;
        r.chroma_subsampling_y = (tmp >> 2) & 1;
        r.chroma_sample_position = (tmp & 3);
        tmp = readUint8();
        r.reserved = (tmp >> 5) & 7;
        r.buffer = Buffer.from(buf);
        tmp = r.high_bitdepth;
        if (tmp < 10) tmp = 8;
        r.mimeCodec = [
            'av01',
            r.seq_profile,
            ('0' + r.seq_level_idx_0).slice(-2) + (!r.seq_tier_0 ? 'M' : 'H'),
            ('0' + tmp).slice(-2)
        ].join('.');
    }
    return r;
};
Box.boxes.av1C.encodingLength = function (box) {
    return box.buffer.length;
};
Box.boxes.av01 = Box.boxes.VisualSampleEntry;

Box.boxes.hvcC = {};
Box.boxes.hvcC.encode = function _(box, buf, offset) {
    buf = buf ? buf.slice(offset) : Buffer.allocUnsafe(box.buffer.length);
    box.buffer.copy(buf);
    _.bytes = box.buffer.length;
};
Box.boxes.hvcC.decode = function(buf, offset, end) {
    // https://www.iso.org/standard/65216.html
    var p = 0;
    var r = Object.create(null);
    var readUint8 = function() {
        return buf.readUInt8(p++);
    };
    var readUint8Array = function(len) {
        var out = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            out[i] = readUint8();
        }
        return out;
    };
    var readUint16 = function() {
        var v = buf.readUInt16BE(p);
        p += 2;
        return v;
    };
    var readUint32 = function() {
        var v = buf.readUInt32BE(p);
        p += 4;
        return v;
    };
    buf = buf.slice(offset, end);

    var tmp = readUint8();
    this.version = tmp & 0xFF;
    r.configurationVersion = this.version;

    tmp = readUint8();
    r.profile_space = tmp >> 6;
    r.tier_flag = (tmp & 32) >> 5;
    r.profile_idc = (tmp & 0x1f);
    r.profile_compatibility_indications = readUint32();
    r.constraint_indicator_flags = readUint8Array(6);
    r.level_idc = readUint8();
    r.min_spatial_segmentation_idc = readUint16() & 0xfff;
    r.parallelismType = (readUint8() & 3);
    r.chromaFormat = (readUint8() & 3);
    r.bitDepthLumaMinus8 = (readUint8() & 7);
    r.bitDepthChromaMinus8 = (readUint8() & 7);
    r.avgFrameRate = readUint16();

    tmp = readUint8();
    r.constantFrameRate = (tmp >> 6);
    r.numTemporalLayers = (tmp & 13) >> 3;
    r.temporalIdNested = (tmp & 4) >> 2;
    r.lengthSizeMinusOne = (tmp & 3);
    r.buffer = Buffer.from(buf);

    // e.g. 'hvc1.1.6.L93.90';
    var mime = '.';
    if (r.profile_space) {
        mime += String.fromCharCode(64 + r.profile_space);
    }
    mime += r.profile_idc + '.';

    tmp = 0;
    var j = 0, cpl = r.profile_compatibility_indications;
    while (true) {
        tmp = cpl & 1;
        if (++j > 30) {
            break;
        }
        tmp <<= 1;
        cpl >>= 1;
    }
    mime += tmp.toString(16) + '.' + (r.tier_flag ? 'H' : 'L') + r.level_idc;

    tmp = '';
    cpl = r.constraint_indicator_flags;
    for (j = 5; j >= 0; j--) {
        if (cpl[j] || tmp) {
            tmp = '.' + ('0' + Number(cpl[j]).toString(16)).slice(-2) + tmp;
        }
    }
    r.mimeCodec = mime + tmp;
    return r;
};
Box.boxes.hvcC.encodingLength = function(box) {
    return box.buffer.length;
};
Box.boxes.hev1 = Box.boxes.VisualSampleEntry;
Box.boxes.hvc1 = Box.boxes.VisualSampleEntry;

Box.boxes.fullBoxes.sidx = true;
Box.boxes.sidx = {};
Box.boxes.sidx.decode = function(buf, offset) {
    var r = Object.create(null);
    var p = offset + 4, time;

    var readUInt16 = function() {
        var v = buf.readUInt16BE(p);
        p += 2;
        return v;
    };
    var readUInt32 = function() {
        var v = buf.readUInt32BE(p);
        p += 4;
        return v;
    };
    var readUInt64 = function() {
        var hi = readUInt32();
        var lo = readUInt32();
        return (hi * UINT32_MAX) + lo;
    };

    r.referenceId = readUInt32();
    r.timescale = readUInt32();

    if (this.version === 0) {
        r.earliestPresentationTime = readUInt32();
        r.firstOffset = readUInt32();
    }
    else {
        r.earliestPresentationTime = readUInt64();
        r.firstOffset = readUInt64();
    }

    readUInt16(); // skip reserved
    r.count = readUInt16();
    r.entries = new Array(r.count);

    time = r.earliestPresentationTime;
    offset = this.length + r.firstOffset;

    for (var i = 0; i < r.count; i++) {
        var e = r.entries[i] = Object.create(null);
        var t = readUInt32();
        e.type = (t >>> 31) & 1;
        e.size = t & 0x7fffffff;
        e.duration = readUInt32();

        t = readUInt32();
        e.sap = (t >>> 31) & 1;
        e.sapType = (t >>> 28) & 0x7;
        e.sapDelta = t & 0xfffffff;

        // for an exact byte-offset on disk we need to add the size for ftyp+moov
        e.byteOffset = [offset, offset + e.size - 1];
        e.timeOffset = [time, time / r.timescale, e.duration / r.timescale];

        offset += e.size;
        time += e.duration;
    }

    return r;
};

Box.boxes.AudioSampleEntry.decode = function(buf, offset, end) {
    buf = buf.slice(offset, end);
    var length = end - offset;
    var box = {
        dataReferenceIndex: buf.readUInt16BE(6),
        channelCount: buf.readUInt16BE(16),
        sampleSize: buf.readUInt16BE(18),
        sampleRate: buf.readUInt32BE(24),
        children: []
    };

    var ptr = 28;
    while (length - ptr >= 8) {
        var child = Box.decode(buf, ptr, length);
        if (!child.length) break; // BUGFIX: prevent endless loop with QT videos - FIXME
        box.children.push(child);
        box[child.type] = child;
        ptr += child.length;
    }

    return box
};

Box.boxes.stsz.decode = function(buf, offset) {
    buf = buf.slice(offset)
    var size = buf.readUInt32BE(0)
    var num = buf.readUInt32BE(4)
    var entries = []

    if (size === 0) {
        entries = new Array(num)

        for (var i = 0; i < num; i++) {
            entries[i] = buf.readUInt32BE(i * 4 + 8)
        }
    }

    return {
        sample_size: size,
        sample_count: num,
        entries: entries
    }
};
