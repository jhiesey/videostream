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
	self._muxer = new MP4Remuxer(file)
	self._tracks = null

	self._onError = function (err) {
		self.destroy() // don't pass err though so the user doesn't need to listen for errors
	}
	self._onWaiting = function () {
		if (self._tracks) {
			var muxed = self._muxer.seek(self._elem.currentTime)
			self._tracks.forEach(function (track, i) {
				track.muxed.destroy()
				track.muxed = muxed[i]
				track.mediaSource = self._elemWrapper.createWriteStream(track.mediaSource)
			})
			self._pump()
		}
	}
	self._elem.addEventListener('waiting', self._onWaiting)
	self._elem.addEventListener('error', self._onError)

	self._muxer.on('ready', function (data) {
		var muxed = self._muxer.seek(0, true)
		self._tracks = data.map(function (track, i) {
			return {
				muxed: muxed[i],
				mediaSource: self._elemWrapper.createWriteStream(track.mime)
			}
		})
		self._pump()
	})

	self._muxer.on('error', function (err) {
		self._elemWrapper.error(err)
	})
}

VideoStream.prototype._pump = function () {
	var self = this
	self._tracks.forEach(function (track) {
		track.mediaSource.on('error', function (err) {
			self._elemWrapper.error(err)
		})
		pump(track.muxed, track.mediaSource)
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
