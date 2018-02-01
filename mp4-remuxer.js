var bs = require('binary-search')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var mp4 = require('mp4-stream')
var Box = require('mp4-box-encoding')
var RangeSliceStream = require('range-slice-stream')
var Buffer = require('buffer').Buffer

module.exports = MP4Remuxer

function MP4Remuxer (file) {
	var self = this
	EventEmitter.call(self)
	self._tracks = []
	self._fragmentSequence = 1
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
        err.message = 'Cannot parse mp4 file: ' + err.message;
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

    self._decoder.once('box', function(headers) {
        var findNextBox = function() {
            self._decoder.destroy();

            if (self['_' + lastbox]) {
                self._parseMoov();
            }
            else {
                self._findMoov(offset + headers.length);
            }
        };
        fileStream.destroy();

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
    });
};

function RunLengthIndex (entries, countName) {
	var self = this
	self._entries = entries
	self._countName = countName || 'count'
	self._index = 0
	self._offset = 0

	self.value = self._entries[0]
}

RunLengthIndex.prototype.inc = function () {
	var self = this
	self._offset++
	if (self._offset >= self._entries[self._index][self._countName]) {
		self._index++
		self._offset = 0
	}

	self.value = self._entries[self._index]
}

MP4Remuxer.prototype._processMoov = function (moov) {
	var self = this

	var traks = moov.traks
	self._tracks = []
	self._hasVideo = false
	self._hasAudio = false
	for (var i = 0; i < traks.length; i++) {
		var trak = traks[i]
		var stbl = trak.mdia.minf.stbl
		var stco = stbl.stco || stbl.co64;
		var stsdEntry = stbl.stsd.entries[0]
		var handlerType = trak.mdia.hdlr.handlerType
		var codec
		var mime
        if (d) {
            console.debug('handler=%s, type=%s, trak:', handlerType, stsdEntry.type, trak);
        }
		if (handlerType === 'vide' && stsdEntry.type === 'avc1') {
			if (self._hasVideo) {
				continue
			}
			self._hasVideo = true
			codec = 'avc1'
			if (stsdEntry.avcC) {
				codec += '.' + stsdEntry.avcC.mimeCodec
			}
			mime = 'video/mp4; codecs="' + codec + '"'
            if (d) {
                console.debug(mime);
            }
		} else if (handlerType === 'soun' && stsdEntry.type === 'mp4a') {
			if (self._hasAudio) {
				continue
			}
			codec = 'mp4a'
			if (stsdEntry.esds && stsdEntry.esds.mimeCodec) {
				codec += '.' + stsdEntry.esds.mimeCodec
			}
			mime = 'audio/mp4; codecs="' + codec + '"'
            if (d) {
                console.debug(mime);
            }
            if (!MediaSource.isTypeSupported(mime)) {
                // Let's continue without audio if actually unsupported, e.g. mp4a.6B (MP3)
                continue;
            }
            self._hasAudio = true
		} else {
			continue
		}

		var samples = []
		var sample = 0

		// Chunk/position data
		var sampleInChunk = 0
		var chunk = 0
		var offsetInChunk = 0
		var sampleToChunkIndex = 0

		// Time data
		var dts = 0
		var decodingTimeEntry = new RunLengthIndex(stbl.stts.entries)
		var presentationOffsetEntry = null
		if (stbl.ctts) {
			presentationOffsetEntry = new RunLengthIndex(stbl.ctts.entries)
		}

		// Sync table index
		var syncSampleIndex = 0

		while (true) {
			var currChunkEntry = stbl.stsc.entries[sampleToChunkIndex]

			// Compute size
			var size = stbl.stsz.entries[sample]

			// Compute time data
			var duration = decodingTimeEntry.value.duration
			var presentationOffset = presentationOffsetEntry ? presentationOffsetEntry.value.compositionOffset : 0

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
			if (sample >= stbl.stsz.entries.length) {
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

		var defaultSampleDescriptionIndex = currChunkEntry.sampleDescriptionId

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
    highWaterMark = (highWaterMark + 0x1000000) & -0x1000000;

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

MP4Remuxer.prototype._findSampleBefore = function (trackInd, time) {
	var self = this

	var track = self._tracks[trackInd]
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
	// Find the preceeding sync sample
	while (!track.samples[sample].sync) {
		sample--
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
	for (var j = firstSample; j < lastSample; j++) {
		var currSample = currTrack.samples[j]
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
			sequenceNumber: self._fragmentSequence++
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
				entries: entries
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
Box.boxes.co64 = {};
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
