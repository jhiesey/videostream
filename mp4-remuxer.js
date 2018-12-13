const bs = require('binary-search')
const EventEmitter = require('events')
const mp4 = require('mp4-stream')
const Box = require('mp4-box-encoding')
const RangeSliceStream = require('range-slice-stream')

// if we want to ignore more than this many bytes, request a new stream.
// if we want to ignore fewer, just skip them.
const FIND_MOOV_SEEK_SIZE = 4096

class MP4Remuxer extends EventEmitter {
  constructor (file) {
    super()

    this._tracks = []
    this._file = file
    this._decoder = null
    this._findMoov(0)
  }

  _findMoov (offset) {
    if (this._decoder) {
      this._decoder.destroy()
    }

    let toSkip = 0
    this._decoder = mp4.decode()
    const fileStream = this._file.createReadStream({
      start: offset
    })
    fileStream.pipe(this._decoder)

    const boxHandler = headers => {
      if (headers.type === 'moov') {
        this._decoder.removeListener('box', boxHandler)
        this._decoder.decode(moov => {
          fileStream.destroy()
          try {
            this._processMoov(moov)
          } catch (err) {
            err.message = `Cannot parse mp4 file: ${err.message}`
            this.emit('error', err)
          }
        })
      } else if (headers.length < FIND_MOOV_SEEK_SIZE) {
        toSkip += headers.length
        this._decoder.ignore()
      } else {
        this._decoder.removeListener('box', boxHandler)
        toSkip += headers.length
        fileStream.destroy()
        this._decoder.destroy()
        this._findMoov(offset + toSkip)
      }
    }
    this._decoder.on('box', boxHandler)

  }

  _processMoov (moov) {
    const traks = moov.traks
    this._tracks = []
    this._hasVideo = false
    this._hasAudio = false
    for (let i = 0; i < traks.length; i++) {
      const trak = traks[i]
      const stbl = trak.mdia.minf.stbl
      const stsdEntry = stbl.stsd.entries[0]
      const handlerType = trak.mdia.hdlr.handlerType
      let codec
      let mime
      if (handlerType === 'vide' && stsdEntry.type === 'avc1') {
        if (this._hasVideo) {
          continue
        }
        this._hasVideo = true
        codec = 'avc1'
        if (stsdEntry.avcC) {
          codec += `.${stsdEntry.avcC.mimeCodec}`
        }
        mime = `video/mp4; codecs="${codec}"`
      } else if (handlerType === 'soun' && stsdEntry.type === 'mp4a') {
        if (this._hasAudio) {
          continue
        }
        this._hasAudio = true
        codec = 'mp4a'
        if (stsdEntry.esds && stsdEntry.esds.mimeCodec) {
          codec += `.${stsdEntry.esds.mimeCodec}`
        }
        mime = `audio/mp4; codecs="${codec}"`
      } else {
        continue
      }

      const samples = []
      let sample = 0

      // Chunk/position data
      let sampleInChunk = 0
      let chunk = 0
      let offsetInChunk = 0
      let sampleToChunkIndex = 0

      // Time data
      let dts = 0
      const decodingTimeEntry = new RunLengthIndex(stbl.stts.entries)
      let presentationOffsetEntry = null
      if (stbl.ctts) {
        presentationOffsetEntry = new RunLengthIndex(stbl.ctts.entries)
      }

      // Sync table index
      let syncSampleIndex = 0

      while (true) {
        var currChunkEntry = stbl.stsc.entries[sampleToChunkIndex]

        // Compute size
        const size = stbl.stsz.entries[sample]

        // Compute time data
        const duration = decodingTimeEntry.value.duration
        const presentationOffset = presentationOffsetEntry ? presentationOffsetEntry.value.compositionOffset : 0

        // Compute sync
        let sync = true
        if (stbl.stss) {
          sync = stbl.stss.entries[syncSampleIndex] === sample + 1
        }

        // Create new sample entry
        const chunkOffsetTable = stbl.stco || stbl.co64
        samples.push({
          size,
          duration,
          dts,
          presentationOffset,
          sync,
          offset: offsetInChunk + chunkOffsetTable.entries[chunk]
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
          const nextChunkEntry = stbl.stsc.entries[sampleToChunkIndex + 1]
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

      const defaultSampleDescriptionIndex = currChunkEntry.sampleDescriptionId

      const trackMoov = {
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
            defaultSampleDescriptionIndex,
            defaultSampleDuration: 0,
            defaultSampleSize: 0,
            defaultSampleFlags: 0
          }]
        }
      }

      this._tracks.push({
        fragmentSequence: 1,
        trackId: trak.tkhd.trackId,
        timeScale: trak.mdia.mdhd.timeScale,
        samples,
        currSample: null,
        currTime: null,
        moov: trackMoov,
        mime
      })
    }

    if (this._tracks.length === 0) {
      this.emit('error', new Error('no playable tracks'))
      return
    }

    // Must be set last since this is used above
    moov.mvhd.duration = 0

    this._ftyp = {
      type: 'ftyp',
      brand: 'iso5',
      brandVersion: 0,
      compatibleBrands: [
        'iso5'
      ]
    }

    const ftypBuf = Box.encode(this._ftyp)
    const data = this._tracks.map(track => {
      const moovBuf = Box.encode(track.moov)
      return {
        mime: track.mime,
        init: Buffer.concat([ftypBuf, moovBuf])
      }
    })

    this.emit('ready', data)
  }

  seek (time) {
    if (!this._tracks) {
      throw new Error('Not ready yet; wait for \'ready\' event')
    }

    if (this._fileStream) {
      this._fileStream.destroy()
      this._fileStream = null
    }

    let startOffset = -1
    this._tracks.map((track, i) => {
      // find the keyframe before the time
      // stream from there
      if (track.outStream) {
        track.outStream.destroy()
      }
      if (track.inStream) {
        track.inStream.destroy()
        track.inStream = null
      }
      const outStream = track.outStream = mp4.encode()
      const fragment = this._generateFragment(i, time)
      if (!fragment) {
        return outStream.finalize()
      }

      if (startOffset === -1 || fragment.ranges[0].start < startOffset) {
        startOffset = fragment.ranges[0].start
      }

      const writeFragment = (frag) => {
        if (outStream.destroyed) return
        outStream.box(frag.moof, err => {
          if (err) return this.emit('error', err)
          if (outStream.destroyed) return
          const slicedStream = track.inStream.slice(frag.ranges)
          slicedStream.pipe(outStream.mediaData(frag.length, err => {
            if (err) return this.emit('error', err)
            if (outStream.destroyed) return
            const nextFrag = this._generateFragment(i)
            if (!nextFrag) {
              return outStream.finalize()
            }
            writeFragment(nextFrag)
          }))
        })
      }
      writeFragment(fragment)
    })

    if (startOffset >= 0) {
      const fileStream = this._fileStream = this._file.createReadStream({
        start: startOffset
      })

      this._tracks.forEach(track => {
        track.inStream = new RangeSliceStream(startOffset, {
          // Allow up to a 10MB offset between audio and video,
          // which should be fine for any reasonable interleaving
          // interval and bitrate
          highWaterMark: 10000000
        })
        fileStream.pipe(track.inStream)
      })
    }

    return this._tracks.map(track => {
      return track.outStream
    })
  }

  _findSampleBefore (trackInd, time) {
    const track = this._tracks[trackInd]
    const scaledTime = Math.floor(track.timeScale * time)
    let sample = bs(track.samples, scaledTime, (sample, t) => {
      const pts = sample.dts + sample.presentationOffset// - track.editShift
      return pts - t
    })
    if (sample === -1) {
      sample = 0
    } else if (sample < 0) {
      sample = -sample - 2
    }
    // sample is now the last sample with dts <= time
    // Find the preceeding sync sample
    while (!track.samples[sample].sync) {
      sample--
    }
    return sample
  }

  _generateFragment (track, time) {
    /*
        1. Find correct sample
        2. Process backward until sync sample found
        3. Process forward until next sync sample after MIN_FRAGMENT_DURATION found
        */
    const currTrack = this._tracks[track]
    let firstSample
    if (time !== undefined) {
      firstSample = this._findSampleBefore(track, time)
    } else {
      firstSample = currTrack.currSample
    }

    if (firstSample >= currTrack.samples.length) { return null }

    const startDts = currTrack.samples[firstSample].dts

    let totalLen = 0
    const ranges = []
    for (var currSample = firstSample; currSample < currTrack.samples.length; currSample++) {
      const sample = currTrack.samples[currSample]
      if (sample.sync && sample.dts - startDts >= currTrack.timeScale * MIN_FRAGMENT_DURATION) {
        break // This is a reasonable place to end the fragment
      }

      totalLen += sample.size
      const currRange = ranges.length - 1
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
      moof: this._generateMoof(track, firstSample, currSample),
      ranges,
      length: totalLen
    }
  }

  _generateMoof (track, firstSample, lastSample) {
    const currTrack = this._tracks[track]

    const entries = []
    let trunVersion = 0
    for (let j = firstSample; j < lastSample; j++) {
      const currSample = currTrack.samples[j]
      if (currSample.presentationOffset < 0) { trunVersion = 1 }
      entries.push({
        sampleDuration: currSample.duration,
        sampleSize: currSample.size,
        sampleFlags: currSample.sync ? 0x2000000 : 0x1010000,
        sampleCompositionTimeOffset: currSample.presentationOffset
      })
    }

    const moof = {
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
          entries,
          version: trunVersion
        }
      }]
    }

    // Update the offset
    moof.trafs[0].trun.dataOffset += Box.encodingLength(moof)

    return moof
  }
}

class RunLengthIndex {
  constructor (entries, countName) {
    this._entries = entries
    this._countName = countName || 'count'
    this._index = 0
    this._offset = 0

    this.value = this._entries[0]
  }

  inc () {
    this._offset++
    if (this._offset >= this._entries[this._index][this._countName]) {
      this._index++
      this._offset = 0
    }

    this.value = this._entries[this._index]
  }
}

function empty () {
  return {
    version: 0,
    flags: 0,
    entries: []
  }
}

const MIN_FRAGMENT_DURATION = 1 // second

module.exports = MP4Remuxer
