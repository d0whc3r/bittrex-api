const cloudscraper = require('cloudscraper');
const signalR = require('signalr-client');
const jsSHA = require('jssha');
const request = require('request');

module.exports = (options) => {

  const BASE_URL = 'https://bittrex.com/';

  const DEFAULT_OPTIONS = {
    apikey: null,
    apisecret: null,
    verbose: false,
    baseUrl: 'https://bittrex.com/api/v1.1',
    baseUrlv2: 'https://bittrex.com/Api/v2.0',
    websockets_baseurl: 'wss://socket.bittrex.com/signalr',
    websockets_hubs: ['CoreHub'],
    serviceHandlers: {
      bound: () => {
        OPTIONS.verbose && console.log('Websocket bound');
      },
      connectFailed: (error) => {
        OPTIONS.verbose && console.log('Websocket connectFailed: ', error);
      },
      disconnected: () => {
        OPTIONS.verbose && console.log('Websocket disconnected');
        wsClient.start(); // ensure we try reconnect
      },
      onerror: (error) => {
        OPTIONS.verbose && console.log('Websocket onerror: ', error);
      },
      bindingError: (error) => {
        OPTIONS.verbose && console.log('Websocket bindingError: ', error);
      },
      connectionLost: (error) => {
        OPTIONS.verbose && console.log('Connection Lost: ', error);
      },
      reconnecting: (retry) => {
        OPTIONS.verbose && console.log('Websocket Retrying: ', retry);
        // change to true to stop retrying
        return false;
      }
    }
  };

  let OPTIONS = Object.assign({}, DEFAULT_OPTIONS, options || {});

  const REQUEST_OPTIONS = {
    method: 'GET',
    agent: false,
    headers: {
      'User-Agent': 'Mozilla/4.0 (compatible; Node Bittrex API)',
      'Content-type': 'application/x-www-form-urlencoded'
    }
  };

  /**
   * Generate nonce for requests
   */
  const getNonce = () => Math.floor(new Date().getTime() / 1000);

  let wsClient = null;

  /**
   * Open websocket connection
   * @returns {*} Promise with websocket client
   */
  const connectWs = () => {
    if (wsClient) {
      return Promise.resolve(wsClient);
    }
    return new Promise((resolve, reject) => {
      // Use cloudscrape to bypass cloudflare
      cloudscraper.get(BASE_URL, (err, response, body) => {
        if (err) {
          console.error('Cloudscraper error', err);
          return reject(err);
        }

        OPTIONS.headers = {
          cookie: response.request.headers['cookie'],
          user_agent: response.request.headers['User-Agent']
        };

        wsClient = new signalR.client(OPTIONS.websockets_baseurl, OPTIONS.websockets_hubs, undefined, true);
        wsClient.headers['cookie'] = OPTIONS.headers.cookie;
        wsClient.headers['User-Agent'] = OPTIONS.headers.user_agent;
        wsClient.start();

        wsClient.serviceHandlers = OPTIONS.serviceHandlers;

        resolve(wsClient);
      });
    });
  };

  /**
   * Parse message received from websocket into a callback
   * @param wsclient Websocket client to handle message received
   * @param callback Callback function to send response
   * @returns {Promise} Promise with websocket client
   */
  const parseMessage = (wsclient, callback) => {
    return new Promise((resolve, reject) => {
      wsclient.serviceHandlers.messageReceived = (message) => {
        try {
          const data = JSON.parse(message.utf8Data);
          if (data && data.M) {
            data.M.forEach((M) => {
              callback(M, wsclient);
            });

          } else {
            OPTIONS.verbose && console.log('Unhandled data', data);
            callback({ 'unhandled_data': data }, wsclient);
          }

          resolve(wsclient);

        } catch (e) {
          OPTIONS.verbose && console.error(e);
          reject(e);
        }
      };
    });
  };

  /**
   * Subscribe to delta exchange market
   * @param wsclient Websocket client to handle connection
   * @param markets Array of markets to subscribe
   */
  const setConnectedWs = (wsclient, markets) => {
    if (!Array.isArray(markets)) {
      markets = [markets];
    }
    wsclient.serviceHandlers.connected = (connection) => {
      markets.forEach((market) => {
        wsclient.call('CoreHub', 'SubscribeToExchangeDeltas', market)
          .done((err, result) => {
            if (err) {
              return console.error(err);
            }

            if (result) {
              OPTIONS.verbose && console.log(`Subscribed to ${market}`);
            }
          });
      });
      OPTIONS.verbose && console.log('Websocket connected');
    };
  };

  /**
   * Request parameters with api key and nonce
   * @param uri Uri send request
   */
  const apiCredentials = (uri) => {
    const options = {
      apikey: OPTIONS.apikey,
      nonce: getNonce()
    };

    return setRequestUriGetParams(uri, options);
  };

  /**
   * Update params for request with apsign header
   * @param uri Uri to send request
   * @param options Options for the request
   * @returns {*} Options parsed for request
   */
  const setRequestUriGetParams = (uri, options) => {
    let op;
    if (typeof uri === 'object') {
      op = uri;
      uri = op.uri;
    } else {
      op = Object.assign({}, REQUEST_OPTIONS);
    }

    Object.keys(options).forEach((key) => {
      uri = updateQueryStringParameter(uri, key, options[key]);
    });

    const shaObj = new jsSHA('SHA-512', 'TEXT');
    shaObj.setHMACKey(OPTIONS.apisecret, 'TEXT');
    shaObj.update(uri);
    op.headers.apisign = shaObj.getHMAC('HEX');
    op.uri = uri;

    return op;
  };

  /**
   * Update query parameters for request
   * @param uri Uri to request
   * @param key Key of query parameter
   * @param value Value of query parameter
   * @returns {*} String uri with query parameters
   */
  const updateQueryStringParameter = (uri, key, value) => {
    const re = new RegExp('([?&])' + key + '=.*?(&|$)', 'i');
    const separator = uri.indexOf('?') >= 0 ? '&' : '?';

    if (uri.match(re)) {
      uri = uri.replace(re, `$1${key}=${value}$2`);
    } else {
      uri = `${uri}${separator}${key}=${value}`;
    }

    return uri;
  };

  /**
   * Manage callback response for received server message
   * @param callback Callback function to execute on every message
   * @param op Options for the request
   */
  const sendRequestCallback = (callback, op) => {
    const start = Date.now();

    request(op, (error, result, body) => {
      OPTIONS.verbose && console.log(`requested from ${op.uri} in: %ds`, (Date.now() - start) / 1000);
      if (!body || !result || result.statusCode !== 200) {
        const errorObj = {
          success: false,
          message: 'URL request error',
          error: error,
          result: result,
        };
        return callback(null, errorObj);
      } else {
        const response = JSON.parse(body);
        if (!response.success) {
          // error returned by bittrex API - forward the response as an error
          return callback(null, response);
        }
        return callback(response, null);
      }
    });
  };

  /**
   * Request a url without api keys
   * @param url Url to send request
   * @param callback Callback function to manage responses
   * @param options Options for the request
   */
  const publicApiCall = (url, callback, options) => {
    let op = Object.assign({}, REQUEST_OPTIONS);
    if (!options) {
      op.uri = url;
    } else {
      op = setRequestUriGetParams(url, options);
    }
    sendRequestCallback(callback, op);
  };

  /**
   * Request a url using api keys
   * @param url Url to send request
   * @param callback Callback function to manage responses
   * @param options Options for the request
   */
  const credentialApiCall = (url, callback, options) => {
    if (options) {
      options = setRequestUriGetParams(apiCredentials(url), options);
    }
    sendRequestCallback(callback, options);
  };

  return {
    options: (options) => {
      OPTIONS = Object.assign({}, OPTIONS, options);
      return this;
    },
    websockets: {
      listen: (callback) => {
        return connectWs()
          .then((wsclient) => parseMessage(wsclient, callback));
      },
      subscribe: (markets, callback) => {
        return connectWs()
          .then((wsclient) => {
            setConnectedWs(wsclient, markets);
            return parseMessage(wsclient, callback);
          });
      },
    },
    sendCustomRequest: (request_string, callback, credentials = false) => {
      let op;

      if (credentials) {
        op = apiCredentials(request_string);
      } else {
        op = Object.assign({}, REQUEST_OPTIONS, { uri: request_string });
      }
      sendRequestCallback(callback, op);
    },
    getmarkets: (callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getmarkets`, callback, null);
    },
    getcurrencies: (callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getcurrencies`, callback, null);
    },
    getticker: (options, callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getticker`, callback, options);
    },
    getmarketsummaries: (callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getmarketsummaries`, callback, null);
    },
    getmarketsummary: (options, callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getmarketsummary`, callback, options);
    },
    getorderbook: (options, callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getorderbook`, callback, options);
    },
    getmarkethistory: (options, callback) => {
      publicApiCall(`${OPTIONS.baseUrl}/public/getmarkethistory`, callback, options);
    },
    getcandles: (options, callback) => {
      publicApiCall(`${OPTIONS.baseUrlv2}/pub/market/GetTicks`, callback, options);
    },
    buylimit: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/buylimit`, callback, options);
    },
    buymarket: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/buymarket`, callback, options);
    },
    selllimit: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/selllimit`, callback, options);
    },
    sellmarket: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/sellmarket`, callback, options);
    },
    cancel: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/cancel`, callback, options);
    },
    getopenorders: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/market/getopenorders`, callback, options);
    },
    getbalances: (callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getbalances`, callback, {});
    },
    getbalance: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getbalance`, callback, options);
    },
    getwithdrawalhistory: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getwithdrawalhistory`, callback, options);
    },
    getdepositaddress: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getdepositaddress`, callback, options);
    },
    getdeposithistory: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getdeposithistory`, callback, options);
    },
    getorderhistory: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getorderhistory`, callback, options || {});
    },
    getorder: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/getorder`, callback, options);
    },
    withdraw: (options, callback) => {
      credentialApiCall(`${OPTIONS.baseUrl}/account/withdraw`, callback, options);
    },
  };
};
