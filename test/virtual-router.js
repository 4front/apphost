var express = require('express');
var supertest = require('supertest');
var _ = require('lodash');
var virtualRouter = require('../lib/middleware/virtual-router');
var assert = require('assert');
var path = require('path');
var querystring = require('querystring');

// TODO: Need to support 4 arrity middleware
describe('virtualRouter', function() {
  before(function() {
    var self = this;
    this.server = express();

    this.virtualApp = {
      name: 'test-app'
    };

    this.env = {};

    this.manifest = {};
    this.server.use(function(req, res, next) {
      req.ext = {
        virtualApp: self.virtualApp,
        virtualAppVersion: {
          manifest: self.manifest
        },
        env: self.env,
        addons: []
      };
      next();
    });

    this.server.use(virtualRouter({
      builtInAddonsDir: path.join(__dirname, "./fixtures/addons")
    }));

    this.server.use(function(req, res, next) {
      res.json(req.ext);
    });

    this.server.use(function(err, req, res, next) {
      res.statusCode = err.status || 500;
      if (res.statusCode === 500 || res.statusCode > 501)
        console.log(err.stack || err.message || err.toString());

      res.json(err);
    });
  });

  it('invokes two addons', function(done) {
    this.manifest.router = [
      {
        module: 'passthrough',
        options: {
          value: 1
        }
      },
      {
        module: 'passthrough',
        path: '/',
        method: 'get',
        options: {
          value: 2
        }
      }
    ];

    supertest(this.server)
      .get('/')
      .expect(200)
      .expect(function(res) {
        assert.ok(_.isEqual(res.body.addons, [1, 2]));
      })
      .end(done);
  });

  it('only plugins with matching route execute', function(done) {
    this.manifest.router = [
      {
        module: 'passthrough',
        options: {
          value: 1
        },
        path: '/foo',
        method: 'get'
      },
      {
        module: 'passthrough',
        options: {
          value: 2
        },
        path: '/bar'
      }
    ];

    supertest(this.server)
      .get('/foo')
      .expect(200)
      .expect(function(res) {
        assert.ok(_.isEqual(res.body.addons, [1]));
      })
      .end(done);
  });

  it('missing middleware function returns 501 response', function(done) {
    this.manifest.router = [
      {
        module: 'invalid'
      }
    ];

    supertest(this.server)
      .get('/')
      .expect(501)
      .expect(function(res) {
        assert.equal(res.body.code, "addonLoadError")
      })
      .end(done);
  });

  it('returns 501 response for invalid method', function(done) {
    this.manifest.router = [
      {
        module: 'passthrough',
        path: '/',
        method: 'blah'
      }
    ];

    supertest(this.server)
      .get('/')
      .expect(501)
      .expect(function(res) {
        assert.equal(res.body.code, "invalidVirtualRouteMethod")
      })
      .end(done);
  });

  it('plugin chain stops when next not invoked', function(done) {
    this.manifest.router = [
      {
        path: '/text',
        module: 'sendtext',
        options: {
          text: 'hello!'
        }
      },
      {
        module: 'next-error',
        path: '/',
        options: {
          message: 'error message'
        }
      }
    ];

    supertest(this.server)
      .get('/text')
      .expect(200)
      .expect('Content-Type', /^text\/plain/)
      .expect('hello!')
      .end(done);
  });

  describe('environment variable substitution', function() {
    beforeEach(function() {
      this.env.KEY1 = "key1_value";
      this.env.KEY2 = "key2_value";
    });

    it('substitutes values correctly', function(done) {
      this.manifest.router = [
        {
          module: 'echo-options',
          options: {
            option1: "env:KEY1",
            another: 'foo',
            more: {
              option2: "env:KEY2"
            }
          },
          path: '/options'
        }
      ];

      supertest(this.server)
        .get('/options')
        .expect(200)
        .expect(function(res) {
          assert.deepEqual(res.body, {
            option1: "key1_value",
            another: 'foo',
            more: {
              option2: "key2_value"
            }
          });
        })
        .end(done);
    });

    it('throws error for missing environment variable', function(done) {
      this.manifest.router = [
        {
          module: 'echo-options',
          options: {
            option1: "env:MISSING",
          },
          path: '/options'
        }
      ];

      supertest(this.server)
        .get('/options')
        .expect(501)
        .expect(function(res) {
          assert.equal(res.body.code, "virtualRouterOptionsError")
        })
        .end(done);
    });
  });

  describe('regex expansion', function() {
    it('expands regex', function(done) {
      this.manifest.router = [
        {
          module: 'echo-options',
          options: {
            option1: "regex:/\\",
          },
          path: '/options'
        }
      ];

      supertest(this.server)
        .get('/options')
        .expect(501)
        .expect(function(res) {
          assert.equal(res.body.code, "virtualRouterOptionsError")
        })
        .end(done);
    });
  });
});
