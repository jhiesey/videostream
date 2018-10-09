const MediaElementWrapper = require('mediasource')
const pump = require('pump')

const MP4Remuxer = require('./mp4-remuxer')

function VideoStream (file, mediaElem, opts) {
  const self = this
  if (!(this instanceof VideoStream)) return new VideoStream(file, mediaElem, opts)
  opts = opts || {}

  self.detailedError = null

  self._elem = mediaElem
  self._elemWrapper = new MediaElementWrapper(mediaElem)
  self._waitingFired = false
  self._trackMeta = null
  self._file = file
  self._tracks = null
  if (self._elem.preload !== 'none') {
    self._createMuxer()
  }

  self._onError = () => {
    self.detailedError = self._elemWrapper.detailedError
    self.destroy() // don't pass err though so the user doesn't need to listen for errors
  }
  self._onWaiting = () => {
    self._waitingFired = true
    if (!self._muxer) {
      self._createMuxer()
    } else if (self._tracks) {
      self._pump()
    }
  }
  if (self._elem.autoplay) { self._elem.preload = 'auto' }
  self._elem.addEventListener('waiting', self._onWaiting)
  self._elem.addEventListener('error', self._onError)
}

VideoStream.prototype._createMuxer = function () {
  const self = this
  self._muxer = new MP4Remuxer(self._file)
  self._muxer.on('ready', data => {
    self._tracks = data.map(trackData => {
      const mediaSource = self._elemWrapper.createWriteStream(trackData.mime)
      mediaSource.on('error', err => {
        self._elemWrapper.error(err)
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

    if (self._waitingFired || self._elem.preload === 'auto') {
      self._pump()
    }
  })

  self._muxer.on('error', err => {
    self._elemWrapper.error(err)
  })
}

VideoStream.prototype._pump = function () {
  const self = this

  const muxed = self._muxer.seek(self._elem.currentTime, !self._tracks)

  self._tracks.forEach((track, i) => {
    const pumpTrack = () => {
      if (track.muxed) {
        track.muxed.destroy()
        track.mediaSource = self._elemWrapper.createWriteStream(track.mediaSource)
        track.mediaSource.on('error', err => {
          self._elemWrapper.error(err)
        })
      }
      track.muxed = muxed[i]
      pump(track.muxed, track.mediaSource)
    }
    if (!track.initFlushed) {
      track.onInitFlushed = err => {
        if (err) {
          self._elemWrapper.error(err)
          return
        }
        pumpTrack()
      }
    } else {
      pumpTrack()
    }
  })
}

VideoStream.prototype.destroy = function () {
  const self = this
  if (self.destroyed) {
    return
  }
  self.destroyed = true

  self._elem.removeEventListener('waiting', self._onWaiting)
  self._elem.removeEventListener('error', self._onError)

  if (self._tracks) {
    self._tracks.forEach(track => {
      if (track.muxed) {
        track.muxed.destroy()
      }
    })
  }

  self._elem.src = ''
}

module.exports = VideoStream
