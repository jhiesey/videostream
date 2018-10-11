const http = require('http')
const MultiStream = require('multistream')
const stream = require('stream')
const VideoStream = require('../')

// This demo requires sintel.mp4 to be copied into the example directory
const REQUEST_SIZE = 2000000 // 2mb

class file {
  constructor (path) {
    this.path = path
  }

  createReadStream (opts = {}) {
    let start = opts.start || 0
    let fileSize = -1

    let req = null
    const multi = new MultiStream(cb => {
      const end = opts.end ? (opts.end + 1) : fileSize

      const reqStart = start
      let reqEnd = start + REQUEST_SIZE
      if (end >= 0 && reqEnd > end) {
        reqEnd = end
      }
      if (reqStart >= reqEnd) {
        req = null
        return cb(null, null)
      }

      req = http.get({
        path: this.path,
        headers: {
          range: `bytes=${reqStart}-${reqEnd - 1}`
        }
      }, res => {
        const contentRange = res.headers['content-range']
        if (contentRange) {
          fileSize = parseInt(contentRange.split('/')[1], 10)
        }
        cb(null, res)
      })

      // For the next request
      start = reqEnd
    })
    const destroy = multi.destroy
    multi.destroy = () => {
      if (req) {
        req.destroy()
      }
      destroy.call(multi)
    }
    return multi
  }
}

const video = document.querySelector('video')
video.addEventListener('error', err => {
  console.error(video.error)
})
new VideoStream(new file('sintel.mp4'), video)

/*
const WebTorrent = require('webtorrent')

// This demo uses WebTorrent (https://webtorrent.io)
const client = new WebTorrent()

// Sintel torrent from webtorrent.io (https://webtorrent.io/torrents/sintel.torrent)
const torrentUrl = 'https://webtorrent.io/torrents/sintel.torrent'

client.add(torrentUrl, torrent => {
  // Got torrent metadata!
  console.log('Torrent info hash:', torrent.infoHash)
  // Let's say the first file is a mp4 (h264) video...
  new VideoStream(torrent.files[5], document.querySelector('video'))
})
*/
