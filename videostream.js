var EventEmitter = require('events')
var inherits = require('inherits')
var MediaElementWrapper = require('mediasource')
var pump = require('pump')

var MP4Remuxer = require('./mp4-remuxer')

module.exports = VideoStream

function VideoStream (file, mediaElem, opts) {
	var self = this
	if (!(this instanceof VideoStream)) return new VideoStream(file, mediaElem, opts)
	opts = opts || {}
	EventEmitter.call(self)

	self._elem = mediaElem
	self._elemWrapper = new MediaElementWrapper(mediaElem)
	self._muxer = new MP4Remuxer(file)
	self._tracks = null

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

	self._muxer.on('error', self.emit.bind(self, 'error'))
}

inherits(VideoStream, EventEmitter)

VideoStream.prototype._pump = function () {
	var self = this

	self._tracks.forEach(function (track) {
		pump(track.muxed, track.mediaSource, function (err) {
			if (err && err.message !== 'premature close') {
				self.emit('error', err)
			}
		})
	})
}

VideoStream.prototype.destroy = function (err) {
	var self = this
	if (self.destroyed) {
		return
	}
	self.destroyed = true

	self._elem.removeEventListener('waiting', self._onWaiting)

	if (self._tracks) {
		self._tracks.forEach(function (track) {
			track.muxed.destroy()
		})
	}

	self._elem.src = ''

	if (err) self.emit('error', err)
}
