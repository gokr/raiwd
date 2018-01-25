/**
 * This is a service that has an express HTTP server, connects to an MQTT server
 * for pub/sub operations and uses Redis and PostgreSQL for state management.
 */

const fs = require('fs')
const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
// const mqttRegex = require('mqtt-regex')  // Can be useful to parse out parameters from wildcard MQTT topics
const request = require('request')
// const util = require('util')
// const schedule = require('node-schedule')
const extend = require('extend')   // To merge objects
const winston = require('winston') // Solid logging lib
const redis = require('redis')     // For maintaining session state
const { Pool } = require('pg')   // For proper database stuff

// Default config that is extended (merged) with CONFIG_FILE
const CONFIG_FILE = 'canoed.conf'
var config = {
  logging: {
    level: 'info'
  },
  debug: false,
  server: {
    port: 8080
  },
  rainode: {
    host: 'localhost',
    port: 7076
  },
  postgres: {
    user: 'dbuser',
    host: 'database.server.com',
    database: 'mydb',
    password: 'secretpassword',
    port: 3211
  },
  redis: {
    host: 'localhost',
    port: 6379
  },
  mqtt: {
    url: 'tcp://localhost',
    options: {
      username: 'test',
      password: 'gurka'
    },
    block: {
      opts: {
        qos: 2,
        retain: false
      }
    }
  }
}

// MQTT Client
var mqttClient = null

// Postgres pool client
var pool = null

// Redis Client
var redisClient = null

// An Express server to handle REST calls, either from Canoe or from rai_node callback
var restServer = null

// Patterns for topics
// var xxxMqttRegex = mqttRegex('apartments/+apartment/blind/switch').exec
// var configMqttRegex = mqttRegex('apartments/+apartment/blind/config').exec
// var scheduleConfigMqttRegex = mqttRegex('apartments/+apartment/schedule/config').exec

// Flag to indicate we have already subscribed to topics
var subscribed = false

// Read configuration
function configure () {
  // Read config file if exists
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      var fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
      extend(true, config, fileConfig)
    } catch (e) {
      winston.error('Failed to parse config file: ' + CONFIG_FILE + e.message)
      process.exit(1)
    }
  }
  winston.level = config.logging.level
}

// Connect Postgres
function connectPostgres () {
  pool = new Pool(config.postgres)
  winston.info('Connected to Postgres')
}

// Initialize database for VerneMQ auth
function initializeDb () {
  var sql = `
    CREATE EXTENSION pgcrypto;
    CREATE TABLE vmq_auth_acl
    (
      mountpoint character varying(10) NOT NULL,
      client_id character varying(128) NOT NULL,
      username character varying(128) NOT NULL,
      password character varying(128),
      publish_acl json,
      subscribe_acl json,
      CONSTRAINT vmq_auth_acl_primary_key PRIMARY KEY (mountpoint, client_id, username)
    );`
  const res = await pool.query(sql)
  await pool.end()
}

// Connect Redis
function connectRedis () {
  redisClient = redis.createClient(config.redis.port, config.redis.host, {no_ready_check: true})
  redisClient.auth('password', function (err) {
    if (err) throw err
  })
  redisClient.on('connect', function () {
    winston.info('Connected to Redis')
  })
}

// Connect to MQTT
function connectMQTT () {
  mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options)
  mqttClient.on('connect', function () {
    winston.debug('CONNECTED TO MQTT')
    subscribe()
  })

  // Where all subscribed messages come in
  mqttClient.on('message', function (topic, message) {
    switch (topic) {
      case 'canoecontrol':
        return handleControl(message)
    }
    /*
      var params = switchMqttRegex(topic)
      if (params) {
        return handleSwitch(params.apartment, message)
      }
      params = configMqttRegex(topic)
      if (params) {
        return handleBlindConfig(params.apartment, message)
      }

      params = scheduleConfigMqttRegex(topic)
      if (params) {
        return handleScheduleConfig(params.apartment, message)
      }
    */

    winston.error('No handler for topic %s', topic)
  })
}

function publishBlock (topic, payload) {
  mqttClient.publish(topic, JSON.stringify(payload), config.mqtt.block.opts)
}

// Subscribe to control
function subscribe () {
  if (!subscribed) {
    mqttClient.subscribe('canoecontrol')
    winston.debug('SUBSCRIBED')
    // /+/ for wildcards
    subscribed = true
  }
}

function handleControl (message) {
  var control = JSON.parse(message)
  winston.winston.debug('PARSED CONTROL: ', control)
  // TODO handle control commands
}

// Start the REST server
function startRESTServer () {
  restServer = express()
  restServer.use(bodyParser.json({
    inflate: true,
    limit: '100kb',
    type: function (req) { return true } // Callbacks don't come with a media type so we always presume JSON in body
  }))

  // The RPC functions we offer Canoe
  restServer.post('/rpc', function (req, res) {
    winston.debug('GET URL', req.url)
    // winston.debug('HEADERS', req.headers)
    // winston.debug('QUERY', req.query)
    // winston.debug('BODY', req.body)
    // winston.debug('CONTENT', req.content)

    var spec = req.body
    var action = req.body.action
    switch (action) {
      case 'create_account':
        return createAccount(spec).then((r) => { res.json(r) })
      case 'canoe_server_status':
        return res.json(canoeServerStatus(spec))
      case 'quota_full':
        return res.json(quotaFull(spec))
      case 'update_server_map':
        return res.json(updateServerMap(spec))
      case 'available_supply':
        return availableSupply(spec).then((r) => { res.json(r) })
      default:
        return res.json({error: 'unknown action'})
    }
  })

  // The rai_node callback entry point
  restServer.post('/callback', function (req, res) {
    // winston.debug('POST URL ' + req.url)
    // winston.debug('HEADERS ' + JSON.stringify(req.headers))
    // winston.debug('QUERY ' + JSON.stringify(req.query))
    // winston.debug('POSTBODY ' + JSON.stringify(req.body))
    // winston.debug('IP', req.connection.remoteAddress)
    handleRaiCallback(req.body)
    // We can return immediately
    res.json({})
  })

  restServer.listen(config.server.port)
  winston.debug('SERVER STARTED ON ' + config.server.port)
}

function quotaFull (spec) {
  return {full: false}
}

function updateServerMap (spec) {
  // for acc in accounts:
  //  redis.setk("xrb:" & acc.getStr, walletId)
  // return %*{"status": "ok"}
}

function canoeServerStatus (spec) {
  // Called if calls fail to get a message to show
  if (fs.existsSync('canoeServerStatus.json')) {
    return JSON.parse(fs.readFileSync('canoeServerStatus.json'))
  }
  return {status: 'ok'}
}

function availableSupply (spec) {
  return callRainode(spec)
}

// Create an account given a token and a tokenpass
function createAccount (spec) {
  var values = [spec.token, spec.tokenpass, config.postgres.pubacl, config.postgres.subacl]
  var sql = `WITH x AS (
    SELECT
        ''::text AS mountpoint,
           $1::text AS client_id,
           $1::text AS username,
           $2::text AS password,
           gen_salt('bf')::text AS salt,
           $3::json AS publish_acl,
           $4::json AS subscribe_acl
    ) 
INSERT INTO vmq_auth_acl (mountpoint, client_id, username, password, publish_acl, subscribe_acl)
    SELECT 
        x.mountpoint,
        x.client_id,
        x.username,
        crypt(x.password, x.salt),
        publish_acl,
        subscribe_acl
    FROM x;`
  const res = await pool.query(sql, values)
  await pool.end()
}

function getWalletForAccount (account, cb) {
  // client.set("foo", "bar", redis.print)
  redisClient.get('account:' + account, cb)
}

function handleRaiCallback (blk) {
  var blk2 = JSON.parse(blk.block)
  winston.debug('Acc: ' + blk.account + ' Block: ' + blk2.type + ' amount: ' + blk.amount)

  // Now we can pick out type of block
  var blkType = blk2.type
  var account = blk.account
  // var amount = blk.amount

  // Switch on block type
  switch (blkType) {
    case 'open':
      getWalletForAccount(account, function (err, wallet) {
        if (err) throw err
        if (wallet) {
          publishBlock('wallet/' + wallet.toString() + '/open', blk)
        }
      })
      return
    case 'send':
      account = blk.destination
      getWalletForAccount(account, function (err, wallet) {
        if (err) throw err
        if (wallet) {
          publishBlock('wallet/' + wallet.toString() + '/send', blk)
        }
      })
      return
    case 'receive':
      getWalletForAccount(account, function (err, wallet) {
        if (err) throw err
        if (wallet) {
          publishBlock('wallet/' + wallet + '/receive', blk)
        }
      })
      return
    case 'change':
      winston.debug('A change block ignored')
      return
  }
  winston.error('Unknown block type: ' + blkType)
}

// Make POST call to rai_node
function callRainode (payload) {
  return new Promise(function (resolve, reject) {
    request.post({
      url: 'http://' + config.rainode.host + ':' + config.rainode.port,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
      timeout: 10000,
      callback: function (err, response, body) {
        if (err) {
          winston.debug('ERROR', err)
          reject(err)
        } else {
          var answer = JSON.parse(body)
          winston.debug('ANSWER: ', JSON.stringify(answer))
          resolve(answer)
        }
      }
    })
  })
}

// Want to notify before shutting down
function handleAppExit (options, err) {
  if (err) {
    winston.error(err.stack)
  }
  if (options.cleanup) {
    winston.info('Cleaning up...')
    mqttClient.end(true)
  }
  if (options.exit) {
    winston.info('Calling exit...')
    process.exit()
  }
}

function configureSignals () {
  // Handle the different ways an application can shutdown
  process.on('exit', handleAppExit.bind(null, {
    cleanup: true
  }))
  process.on('SIGINT', handleAppExit.bind(null, {
    exit: true
  }))
  process.on('uncaughtException', handleAppExit.bind(null, {
    exit: true
  }))
}

configure()
configureSignals()
connectPostgres()
connectRedis()
connectMQTT()
startRESTServer()
