var MP4Box = require('mp4box');
var video = document.querySelector('video');

var WebTorrent = require('webtorrent');

var client = new WebTorrent();
var infoHash = 'a54c3ee75cb901001e46da2072ed7bfde7a5374e';

var mediaSource;
var file;
client.add({
	infoHash: infoHash,
	announce: 'wss://tracker.webtorrent.io/'
}, function (torrent) {
	// Got torrent metadata!
	console.log('Torrent info hash:', torrent.infoHash);

	// Let's say the first file is a webm (vp8) or mp4 (h264) video...
	file = torrent.files[0]

	video.addEventListener('waiting', function () {
		if (ready) {
			seek(video.currentTime);
		}
	});

	mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest();
	});
	video.src = window.URL.createObjectURL(mediaSource);
});

var mp4box = new MP4Box();
mp4box.onError = function (e) {
	console.error('MP4Box error:');
	console.error(e);
};
var ready = false;
var tracks = {}; // keyed by id
mp4box.onReady = function (info) {
	console.log('Info:');
	console.log(info);

	info.tracks.forEach(function (track) {
		var mime = 'video/mp4; codecs="' + track.codec + '"';
		if (MediaSource.isTypeSupported(mime)) {
			var sourceBuffer = mediaSource.addSourceBuffer(mime);
			var trackEntry = {
				buffer: sourceBuffer,
				arrayBuffers: [],
				meta: track,
				ended: false
			};
			sourceBuffer.addEventListener('updateend', popBuffers.bind(null, trackEntry));
			mp4box.setSegmentOptions(track.id, null, {
				nbSamples: 500
			});
			tracks[track.id] = trackEntry
		}
	});

	var initSegs = mp4box.initializeSegmentation();
	initSegs.forEach(function (initSegment) {
		appendBuffer(tracks[initSegment.id], initSegment.buffer);
	});
	ready = true;
};

mp4box.onSegment = function (id, user, buffer, nextSample) {
	var track = tracks[id];
	appendBuffer(track, buffer, nextSample === track.meta.nb_samples);
};

var desiredIngestOffset = 0;
var downloadBusy = false;
function makeRequest () {
	if (downloadBusy) {
		return;
	}
	downloadBusy = true;
	var requestOffset = desiredIngestOffset;
	var opts = {
		start: requestOffset,
		end: Math.min(file.length - 1, requestOffset + 100000)
	};
	var stream = file.createReadStream(opts);
	stream.on('data', function (data) {
		if (desiredIngestOffset !== requestOffset) {
			console.warn('moving');
		}
		var arrayBuffer = data.toArrayBuffer(); // TODO: avoid copy
		arrayBuffer.fileStart = requestOffset;
		requestOffset += arrayBuffer.byteLength;
		desiredIngestOffset = mp4box.appendBuffer(arrayBuffer);
	});
	stream.on('end', function () {
		downloadBusy = false;
		if (requestOffset === file.length) {
			mp4box.flush();
		}
		if (desiredIngestOffset !== file.length) {
			makeRequest();
		}
	});
	// });
}

// downloader: specify desired offset, get data events with offsets

function seek (seconds) {
	var seekResult = mp4box.seek(seconds, true);
	console.log('seeking to: ', seconds, ' result: ', seekResult);
	desiredIngestOffset = seekResult.offset;
	console.log('seeked offset:', desiredIngestOffset);
	makeRequest();
}

function appendBuffer (track, buffer, ended) {
	track.arrayBuffers.push({
		buffer: buffer,
		ended: ended || false
	});
	popBuffers(track);
}

function popBuffers (track) {
	updateEnded(); // set call endOfStream() if needed
	if (track.buffer.updating || track.arrayBuffers.length === 0) return;
	var buffer = track.arrayBuffers.shift();
	try {
		track.buffer.appendBuffer(buffer.buffer);
		track.ended = buffer.ended;
	} catch (e) {
		console.warn('error: ', e);
		track.arrayBuffers.unshift(buffer);
	}
	updateEnded();
}

function updateEnded () {
	if (mediaSource.readyState !== 'open') {
		return;
	}

	var ended = Object.keys(tracks).every(function (id) {
		var track = tracks[id];
		return track.ended && !track.buffer.updating;
	});

	if (ended) {
		console.warn('ended');
		mediaSource.endOfStream();
	}
}
