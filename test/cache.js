var supertest = require('supertest');
var async = require('async');
var fs = require('fs');
var zlib = require('zlib');
var _ = require('lodash');
var express = require('express');
var assert = require('assert');
var compressible = require('compressible');
var compression = require('compression');
var shortid = require('shortid');
var through = require('through2');
var testUtil = require('./test-util');
// var memoryCache = require('memory-cache-stream');
var sinon = require('sinon');
var debug = require('debug')('4front:http-host:test');

require('dash-assert');

var redis = require('redis');
require('redis-streams')(redis);

var contentCache = redis.createClient({return_buffers: true});

var cacheControlHeader = 'public, max-age=31536000, no-cache';
var customHeaderPrefix = 'x-4front-';

describe('cache', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.server = express();

    this.mockMetrics = {
      increment: sinon.spy(function() {})
    };

    _.assign(this.server.settings, {
      customHttpHeaderPrefix: customHeaderPrefix,
      contentCache: contentCache,
      metrics: this.mockMetrics
    });

    this.compressionThreshold = null;
    this.overrideCacheControl = null;

    this.versionId = shortid.generate();
    this.appId = shortid.generate();

    this.server.use(function(req, res, next) {
      req.protocol = 'http';
      req.ext = {
        contentCacheEnabled: true,
        virtualApp: {
          appId: self.appId
        },
        virtualAppVersion: {
          versionId: self.versionId,
          name: self.versionId
        }
      };

      if (self.overrideCacheControl) {
        res.setHeader('Cache-Control', self.overrideCacheControl);
      }
      next();
    });

    // Declare the custom event-emitter middleware before compression
    this.server.use(require('../lib/middleware/event-emitter')(this.server.settings));

    // Force everything to be compressed for testing purposes.
    this.server.use(function(req, res, next) {
      compression({
        threshold: self.compressionThreshold || '1kb',
        filter: function() {
          // Don't perform compression if the response content came from server cache.
          return req.ext.cacheHit !== true && compressible(res.get('Content-Type'));
        }
      })(req, res, next);
    });

    this.server.use(require('../lib/middleware/cache')(this.server.settings));

    this.htmlContent = '<html>' + this.versionId + '</html>';

    this.loadContent = sinon.spy(function(req, callback) {
      callback(null, self.htmlContent);
    });

    this.server.get('/', function(req, res, next) {
      res.set('Content-Type', 'text/html');
      self.loadContent(req, function(err, html) {
        if (err) return next(err);
        res.send(html);
      });
    });

    this.server.use(testUtil.errorHandler);
  });

  it('changing versionId should result in new cached content', function(done) {
    var initialCacheKey;
    var nextCacheKey;
    var initialHtmlContent;
    var nextHtmlContent;

    async.series([
      function(cb) {
        supertest(self.server)
          .get('/')
          .expect(200)
          .expect('x-4front-server-cache', /^miss/)
          .expect(self.htmlContent)
          .expect(function(res) {
            assert.isTrue(self.loadContent.called);
            initialCacheKey = getCacheKeyFromHeader(res);
            initialHtmlContent = res.text;
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        self.versionId = shortid.generate();
        self.htmlContent = '<html>' + self.versionId + '</html>';

        supertest(self.server)
          .get('/')
          .expect(200)
          .expect(self.htmlContent)
          .expect(customHeaderPrefix + 'server-cache', /^miss/)
          .expect(function(res) {
            assert.isTrue(self.loadContent.called);
            nextCacheKey = getCacheKeyFromHeader(res);
            nextHtmlContent = res.text;

            assert.notEqual(initialCacheKey, nextCacheKey);
            assert.notEqual(initialHtmlContent, nextHtmlContent);
            assert.isTrue(contentCache.exists(initialCacheKey + '-headers'));
            assert.isTrue(contentCache.exists(nextCacheKey + '-headers'));
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getContentFromCache(initialCacheKey, false, function(err, content) {
          if (err) return cb(err);
          assert.equal(content, initialHtmlContent);
          cb();
        });
      },
      function(cb) {
        getContentFromCache(nextCacheKey, false, function(err, content) {
          assert.equal(content, nextHtmlContent);
          cb();
        });
      }
    ], done);
  });

  it('caches gzipped 200 responses', function(done) {
    var cacheKey;
    var etag;

    // Force everything to be compressed
    this.compressionThreshold = '1b';

    async.series([
      function(cb) {
        supertest(self.server)
          .get('/')
          .expect(200)
          .expect(customHeaderPrefix + 'server-cache', /^miss/)
          .expect('Content-Encoding', 'gzip')
          .expect(self.htmlContent)
          .expect(function(res) {
            assert.isTrue(self.loadContent.called);
            etag = res.get('ETag');
            assert.isString(etag);
            cacheKey = getCacheKeyFromHeader(res);
            assert.isTrue(contentCache.exists(cacheKey + '-content'));
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getContentFromCache(cacheKey, true, function(err, content) {
          if (err) return cb(err);
          assert.equal(content, self.htmlContent);
          cb();
        });
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getHeadersFromCache(cacheKey, function(err, headers) {
          assert.deepEqual(headers, {
            statusCode: '200',
            ETag: etag,
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': cacheControlHeader,
            'Content-Encoding': 'gzip'
          });
          cb();
        });
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        // Now the content is in the cache.
        supertest(self.server).get('/')
          .expect(200)
          .expect(customHeaderPrefix + 'server-cache', /^hit/)
          .expect('Content-Encoding', 'gzip')
          .expect('ETag', etag)
          .expect(self.htmlContent)
          .expect(function(res) {
            assert.equal(getCacheKeyFromHeader(res), cacheKey);
            assert.isFalse(self.loadContent.called);
          })
          .end(cb);
      }
    ], done);
  });

  it('caches non-compressed content', function(done) {
    var cacheKey;
    var etag;

    async.series([
      function(cb) {
        supertest(self.server)
          .get('/')
          .expect(200)
          .expect(customHeaderPrefix + 'server-cache', /^miss/)
          .expect(self.htmlContent)
          .expect(function(res) {
            assert.isUndefined(res.get('Content-Encoding'));
            assert.isTrue(self.loadContent.called);

            etag = res.get('ETag');
            cacheKey = getCacheKeyFromHeader(res);
            assert.isTrue(contentCache.exists(cacheKey + '-content'));
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getContentFromCache(cacheKey, false, function(err, content) {
          if (err) return cb(err);
          assert.equal(content, self.htmlContent);
          cb();
        });
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getHeadersFromCache(cacheKey, function(_err, headers) {
          assert.deepEqual(headers, {
            statusCode: '200',
            ETag: etag,
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': cacheControlHeader
          });
        });
        cb();
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        // Now the content is in the cache.
        supertest(self.server).get('/')
          .expect(200)
          .expect(customHeaderPrefix + 'server-cache', /^hit/)
          .expect('ETag', etag)
          .expect(self.htmlContent)
          .expect(function(res) {
            assert.isUndefined(res.get('Content-Encoding'));
            assert.isFalse(self.loadContent.called);
          })
          .end(cb);
      }
    ], done);
  });

  it('follows cached redirect', function(done) {
    this.server.get('/redirect', function(req, res, next) {
      self.loadContent(req, function(err) {
        if (err) return next(err);
        res.redirect(302, '/destination');
      });
    });

    var cacheKey;
    async.series([
      function(cb) {
        supertest(self.server)
          .get('/redirect')
          .expect(302)
          .expect('Cache-Control', cacheControlHeader)
          .expect(customHeaderPrefix + 'server-cache', /^miss/)
          .expect(function(res) {
            assert.isUndefined(res.get('ETag'));
            assert.isTrue(self.loadContent.called);
            cacheKey = getCacheKeyFromHeader(res);
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        getHeadersFromCache(cacheKey, function(err, headers) {
          if (err) return cb(err);
          assert.deepEqual(headers, {
            statusCode: '302',
            Location: '/destination',
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': cacheControlHeader
          });

          cb();
        });
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        supertest(self.server)
          .get('/redirect')
          .expect(302)
          .expect('Cache-Control', cacheControlHeader)
          .expect(customHeaderPrefix + 'server-cache', /^hit/)
          .expect(function(res) {
            assert.isUndefined(res.get('ETag'));
            assert.equal(getCacheKeyFromHeader(res), cacheKey);
            assert.isFalse(self.loadContent.called);
          })
          .end(cb);
      }
    ], done);
  });

  it('does conditional get with etags', function(done) {
    var initialETag;
    async.series([
      function(cb) {
        supertest(self.server)
          .get('/')
          .expect(200)
          .expect('content-type', /^text\/html/)
          .expect(function(res) {
            assert.isTrue(self.loadContent.called);
            assert.ok(res.headers.etag);
            initialETag = res.headers.etag;
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        supertest(self.server)
          .get('/')
          .set('If-None-Match', initialETag)
          .expect(304)
          .expect(function(res) {
            assert.isUndefined(res.headers[customHeaderPrefix + 'server-cache']);
            assert.isFalse(self.loadContent.called);
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.loadContent.reset();
        // Change the versionId which should result in a different etag.
        self.versionId = shortid.generate();

        supertest(self.server)
          .get('/')
          .set('If-None-Match', initialETag)
          .expect(200)
          .expect(function(res) {
            assert.isTrue(self.loadContent.called);
            assert.ok(res.headers.etag);
            assert.notEqual(res.headers.etag, initialETag);
          })
          .end(cb);
      }
    ], done);
  });

  it('serve jpg image', function(done) {
    var imageName = shortid.generate() + '.jpg';
    var cacheKey;
    var loadImage = sinon.spy(function() {
      return fs.createReadStream(__dirname + '/fixtures/test.jpg');
    });

    this.server.get('/' + imageName, function(req, res, next) {
      res.set('Content-Type', 'image/jpg');
      loadImage().pipe(res);
    });

    async.series([
      function(cb) {
        supertest(self.server)
          .get('/' + imageName)
          .expect(customHeaderPrefix + 'server-cache', /^miss/)
          .expect('Content-Type', 'image/jpg')
          .expect('Cache-Control', cacheControlHeader)
          .expect(function(res) {
            assert.isUndefined(res.get('Content-Encoding'));
            assert.isTrue(loadImage.called);
            cacheKey = getCacheKeyFromHeader(res);
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        loadImage.reset();
        supertest(self.server)
          .get('/' + imageName)
          .expect('Content-Type', 'image/jpg')
          .expect('Cache-Control', cacheControlHeader)
          .expect(customHeaderPrefix + 'server-cache', 'hit ' + cacheKey)
          .expect(function(res) {
            assert.isUndefined(res.get('Content-Encoding'));
            assert.isFalse(loadImage.called);
          })
          .end(cb);
      }
    ], done);
  });

  it('metrics are incremented', function(done) {
    async.series([
      function(cb) {
        supertest(self.server)
          .get('/')
          .expect(200)
          .expect('x-4front-server-cache', /^miss/)
          .expect(function(res) {
            assert.isTrue(self.mockMetrics.increment.calledWith('content-cache-miss'));
          })
          .end(cb);
      },
      function(cb) {
        setTimeout(cb, 20);
      },
      function(cb) {
        self.mockMetrics.increment.reset();

        supertest(self.server)
          .get('/')
          .expect(200)
          .expect(customHeaderPrefix + 'server-cache', /^hit/)
          .expect(function(res) {
            assert.isTrue(self.mockMetrics.increment.calledWith('content-cache-hit'));
          })
          .end(cb);
      }
    ], done);
  });


  it('returns custom headers when response served from cache', function(done) {
    done();
  });

  it('does not cache certain status codes', function(done) {
    // self.contentCache.flushall();
    // this.storage.readFileStream = sinon.spy(function() {
    //   return streamTestUtils.emitter('missing');
    // });
    //
    // this.storage.fileExists = sinon.spy(function(filePath, cb) {
    //   cb(null, false);
    // });
    //
    // supertest(self.server)
    //   .get('/missing')
    //   .expect(404)
    //   .expect('X-Server-Cache', 'MISS')
    //   .expect(function(res) {
    //     assert.isTrue(self.storage.readFileStream.calledWith(sinon.match(/missing\.html/)));
    //     assert.equal(self.contentCache.keys().length, 0);
    //   })
    //   .end(done);
    done();
  });

  it('different accepts headers use different cached responses', function(done) {
    done();
  });

  it('returns proper public no-cache header', function(done) {
    supertest(this.server)
      .get('/')
      .expect(200)
      .expect('Cache-Control', cacheControlHeader)
      .end(done);
  });

  it('does not override Cache-Control if already set', function(done) {
    this.overrideCacheControl = 'public, max-age=10000';

    supertest(this.server)
      .get('/')
      .expect(200)
      .expect('Cache-Control', this.overrideCacheControl)
      .end(done);
  });

  function getCacheKeyFromHeader(res) {
    return res.get('x-4front-server-cache').split(' ')[1];
  }

  function getHeadersFromCache(cacheKey, callback) {
    contentCache.hgetall(cacheKey + '-headers', function(err, hash) {
      if (err) return callback(err);

      hash = _.mapValues(hash, function(value) {
        return value.toString();
      });

      callback(null, hash);
    });
  }

  function getContentFromCache(cacheKey, isCompressed, callback) {
    debug('get content from cache key=%s-content', cacheKey);

    // WHY do I need to create a seperate cache client? Troublesome.
    // var cache = createCache();

    if (!isCompressed) {
      return contentCache.get(cacheKey + '-content', function(err, content) {
        callback(null, content.toString());
      });
    }

    var cachedContent = '';
    contentCache.readStream(cacheKey + '-content')
      .pipe(zlib.createGunzip())
      .pipe(through.obj(function(chunk, enc, cb) {
        debug('reading chunk from %s-content', cacheKey);
        cachedContent += chunk.toString();
        cb(null, chunk);
      }))
      .on('finish', function() {
        callback(null, cachedContent);
      });
  }
});