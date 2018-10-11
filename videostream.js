const MediaElementWrapper = require('mediasource')
const pump = require('pump')

const MP4Remuxer = require('./mp4-remuxer')

function VideoStream (file, mediaElem, opts = {}) {
  if (!(this instanceof VideoStream)) {
    console.warn("don't invoked VideoStream without 'new'")
    return new VideoStream(file, mediaElem, opts)
  }

  this.detailedError = null

  this._elem = mediaElem
  this._elemWrapper = new MediaElementWrapper(mediaElem)
  this._waitingFired = false
  this._trackMeta = null
  this._file = file
  this._tracks = null

  if (this._elem.preload !== 'none') {
    this._createMuxer()
  }

  this._onError = () => {
    this.detailedError = this._elemWrapper.detailedError
    this.destroy() // don't pass err though so the user doesn't need to listen for errors
  }

  this._onWaiting = () => {
    this._waitingFired = true
    if (!this._muxer) {
      this._createMuxer()
    } else if (this._tracks) {
      this._pump()
    }
  }

  if (mediaElem.autoplay) { mediaElem.preload = 'auto' }
  mediaElem.addEventListener('waiting', this._onWaiting)
  mediaElem.addEventListener('error', this._onError)
}

VideoStream.prototype = {
  _createMuxer () {
    this._muxer = new MP4Remuxer(this._file)
    this._muxer.on('ready', data => {
      this._tracks = data.map(trackData => {
        const mediaSource = this._elemWrapper.createWriteStream(trackData.mime)
        mediaSource.on('error', err => {
          this._elemWrapper.error(err)
        })
        const track = {
          muxed: null,
          mediaSource,
          initFlushed: false,
          onInitFlushed: null
        }
        mediaSource.write(trackData.init, err => {
          track.initFlushed = true
          if (track.onInitFlushed) {
            track.onInitFlushed(err)
          }
        })
        return track
      })

      if (this._waitingFired || this._elem.preload === 'auto') {
        this._pump()
      }
    })

    this._muxer.on('error', err => {
      this._elemWrapper.error(err)
    })
  },
  _pump () {
    const muxed = this._muxer.seek(this._elem.currentTime, !this._tracks)

    this._tracks.forEach((track, i) => {
      const pumpTrack = () => {
        if (track.muxed) {
          track.muxed.destroy()
          track.mediaSource = this._elemWrapper.createWriteStream(track.mediaSource)
          track.mediaSource.on('error', err => {
            this._elemWrapper.error(err)
          })
        }
        track.muxed = muxed[i]
        pump(track.muxed, track.mediaSource)
      }
      if (!track.initFlushed) {
        track.onInitFlushed = err => {
          if (err) {
            this._elemWrapper.error(err)
            return
          }
          pumpTrack()
        }
      } else {
        pumpTrack()
      }
    })
  },
  destroy () {
    if (this.destroyed) {
      return
    }
    this.destroyed = true

    this._elem.removeEventListener('waiting', this._onWaiting)
    this._elem.removeEventListener('error', this._onError)

    if (this._tracks) {
      this._tracks.forEach(track => {
        if (track.muxed) {
          track.muxed.destroy()
        }
      })
    }

    this._elem.src = ''
  }
}

module.exports = VideoStream
