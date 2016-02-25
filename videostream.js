var MediaElementWrapper = require('mediasource')
var pump = require('pump')

var MP4Remuxer = require('./mp4-remuxer')

module.exports = VideoStream

function VideoStream (file, mediaElem, opts) {
	var self = this
	if (!(this instanceof VideoStream)) return new VideoStream(file, mediaElem, opts)
	opts = opts || {}

	self._elem = mediaElem
	self._elemWrapper = new MediaElementWrapper(mediaElem)
	self._waitingFired = false
	self._trackMeta = null
	self._muxer = new MP4Remuxer(file)
	self._tracks = null

	self._onError = function (err) {
		self.destroy() // don't pass err though so the user doesn't need to listen for errors
	}
	self._onWaiting = function () {
		self._waitingFired = true
		if (self._trackMeta) {
			self._pump()
		}
	}
	self._elem.addEventListener('waiting', self._onWaiting)
	self._elem.addEventListener('error', self._onError)

	self._muxer.on('ready', function (data) {
		self._trackMeta = data
		if (self._waitingFired) {
			self._pump()
		}
	})

	self._muxer.on('error', function (err) {
		self._elemWrapper.error(err)
	})
}

VideoStream.prototype._pump = function () {
	var self = this

	var muxed = self._muxer.seek(self._elem.currentTime, !self._tracks)

	self._tracks = muxed.map(function (muxedStream, i) {
		var createStreamArg = self._trackMeta[i].mime
		if (self._tracks) {
			createStreamArg = self._tracks[i].mediaSource
			self._tracks[i].muxed.destroy()
		}
		var mediaSource = self._elemWrapper.createWriteStream(createStreamArg)
		mediaSource.on('error', function (err) {
			self._elemWrapper.error(err)
		})
		pump(muxedStream, mediaSource)
		return {
			muxed: muxedStream,
			mediaSource: mediaSource
		}
	})
}

VideoStream.prototype.destroy = function () {
	var self = this
	if (self.destroyed) {
		return
	}
	self.destroyed = true

	self._elem.removeEventListener('waiting', self._onWaiting)
	self._elem.removeEventListener('error', self._onError)

	if (self._tracks) {
		self._tracks.forEach(function (track) {
			track.muxed.destroy()
		})
	}

	self._elem.src = ''
}
