var assert = require('assert');
var express = require('express');
var supertest = require('supertest');
var shortid = require('shortid');
var staticAssetRedirect = require('../lib/middleware/static-asset-redirect');

describe('staticAssetRedirect', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.server = express();
    this.server.set('trust proxy', true);
    this.server.settings.deployedAssetsPath = "somecdn.com";

    this.appId = shortid.generate();
    this.versionId = shortid.generate();

    this.server.use(function(req, res, next) {
      req.ext = {
        virtualApp: {
          appId: self.appId
        },
        virtualAppVersion: {
          versionId: self.versionId
        }
      };

      next();
    });

    this.server.use(staticAssetRedirect());

    this.server.use(function(req, res, next) {
      res.send("html");
    });
  });

  it('redirects to absolute url when deployedAssetsPath is a CDN', function(done) {
    supertest(this.server)
      .get("/images/logo.png")
      .expect(302)
      .expect(function(res) {
        assert.equal(res.headers.location, 'http://somecdn.com/' + self.appId + '/' + self.versionId + '/images/logo.png');
      })
      .end(done);
  });

  it('redirects to https absolute url when deployedAssetsPath is a CDN', function(done) {
    supertest(this.server)
      .get("/images/logo.png")
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', 'blah.app.com')
      .expect(302)
      .expect(function(res) {
        assert.equal(res.headers.location, 'https://somecdn.com/' + self.appId + '/' + self.versionId + '/images/logo.png');
      })
      .end(done);
  });

  it('uses relative url if deployedAssetsPath starts with slash', function(done) {
    this.server.settings.deployedAssetsPath = '/deployments';

    supertest(this.server)
      .get("/images/logo.gif")
      .expect(302)
      .expect(function(res) {
        assert.equal(res.headers.location, '/deployments/' + self.appId + '/' + self.versionId + '/images/logo.gif');
      })
      .end(done);
  });

  it('skips middleware if no file extension', function(done) {
    this.server.settings.deployedAssetsPath = '/deployments';

    supertest(this.server)
      .get("/pages/blog")
      .expect(200)
      .expect('html')
      .end(done);
  });

  it('does not redirect non XHR html requests', function(done) {
    supertest(this.server)
      .get('/pages/about.html')
      .expect(200)
      .expect('html')
      .end(done);
  });

  it('does redirect html ajax requests', function(done) {
    supertest(this.server)
      .get('/views/about.html')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(302)
      .expect(function(res) {
        assert.equal(res.headers.location, 'http://somecdn.com/'
          + self.appId + '/' + self.versionId + '/views/about.html');
      })
      .end(done);
  });
});