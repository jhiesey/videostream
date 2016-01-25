var videostream = require('./videostream');
var stream = require('stream')
var MultiStream = require('multistream')
// var WebTorrent = require('webtorrent');

// // This demo uses WebTorrent (https://github.com/feross/webtorrent)
// var client = new WebTorrent();
// // This hash is for the file at http://mirrorblender.top-ix.org/movies/sintel-1024-surround.mp4
// var infoHash = 'a54c3ee75cb901001e46da2072ed7bfde7a5374e';

// client.add({
// 	infoHash: infoHash,
// 	announce: 'wss://tracker.webtorrent.io/'
// }, function (torrent) {
// 	// Got torrent metadata!
// 	console.log('Torrent info hash:', torrent.infoHash);
// 	// Let's say the first file is a mp4 (h264) video...
// 	videostream(torrent.files[0], document.querySelector('video'));
// 	var v = document.querySelector('video');
// 	v.play();
// });

var REQUEST_SIZE = 2000000 // 2mb


var http = require('http')

var file = function (path) {
	var self = this
	self.path = path
}

file.prototype.createReadStream = function (opts) {
	var self = this
	opts = opts || {}
	var start = opts.start || 0
	var size = 310674005
	var end = opts.end ? (opts.end + 1) : size

	var req = null
	var multi = new MultiStream(function (cb) {
		var reqStart = start
		var reqEnd = start + REQUEST_SIZE
		if (end >= 0 && reqEnd > end) {
			reqEnd = end
		}
		start = reqEnd
		if (reqStart === reqEnd) {
			req = null
			return cb(null, null)
		}
		var isBig = (reqEnd - reqStart > 100000)

		req = http.get({
			path: self.path,
			headers: {
				range: 'bytes=' + reqStart + '-' + (reqEnd - 1)
			},
			mode: isBig ? 'prefer-streaming' : 'prefer-fast'
		}, function (stream) {
			cb(null, stream)
		})
	})
	var destroy = multi.destroy
	multi.destroy = function () {
		if (req) {
			req.destroy()
		}
		destroy.call(multi)
	}
	return multi
}

var video = document.querySelector('video')
video.addEventListener('error', function (err) {
	console.error(video.error)
})
videostream(new file('sintel-2048-surround.mp4'), video)
video.play()
