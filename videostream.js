var MP4Box = require('mp4box');

/**
 * Stream data from `file` into `video`.
 * `file` must be an object with a `length` property giving the file size in bytes,
 * and a `createReadStream(opts)` method that retunr a string and accepts opts.start
 * and opts.end to specify a byte range (inclusive) to fetch.
 */
module.exports = function (file, video, opts) {
	if (!opts) opts = {}

	// Autoplay the video when the "autoplay" option is true, or if the "autoplay" property
	// is set on the `video` tag.
	if (opts.autoplay == null && video.autoplay) opts.autoplay = true;

	video.addEventListener('waiting', function () {
		if (ready) {
			seek(video.currentTime);
		}
	});

	var mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest();
	});
	video.src = window.URL.createObjectURL(mediaSource);

	var mp4box = new MP4Box();
	mp4box.onError = function (e) {
		console.error('MP4Box error:', e);
		mediaSource.endOfStream('decode');
	};
	var ready = false;
	var tracks = {}; // keyed by track id
	mp4box.onReady = function (info) {
		console.log('MP4 info:', info);
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
		stream.on('error', function (err) {
			console.error('Stream error:', err);
			mediaSource.endOfStream('network');
		});
	}

	function seek (seconds) {
		var seekResult = mp4box.seek(seconds, true);
		console.log('Seeking to time: ', seconds);
		desiredIngestOffset = seekResult.offset;
		console.log('Seeked file offset:', desiredIngestOffset);
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
		track.started = true;

		updateEnded(); // set call endOfStream() if needed
		if (track.buffer.updating || track.arrayBuffers.length === 0) return;
		var buffer = track.arrayBuffers.shift();
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
		} catch (e) {
			console.error('SourceBuffer error: ', e);
			// TODO: what to do? for now try again later (if buffer space was the issue)
			track.arrayBuffers.unshift(buffer);
		}
		updateEnded();

		tryAutoplay();
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
			mediaSource.endOfStream();
		}
	}

	function tryAutoplay () {
		if (!opts.autoplay) return;

		for (var id in tracks) {
			var track = tracks[id];
			if (!track.started) return;
		}

		video.play();
		opts.autoplay = false;
	}
};
