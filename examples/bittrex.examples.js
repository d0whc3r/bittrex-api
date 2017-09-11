const Bittrex = require('../bittrex-api');
const APIKEY = 'KEY';
const APISECRET = 'SECRET';

const bittrex = Bittrex({
  'apikey': APIKEY,
  'apisecret': APISECRET,
  'verbose': false,
});

/**
 *  sendCustomRequest example
 */
bittrex.sendCustomRequest('https://bittrex.com/api/v1.1/public/getmarketsummary?market=btc-ltc', function (data) {
  console.log(data);
}, true);

/**
 *  getmarkethistory example
 */
bittrex.getmarkethistory({ market: 'BTC-LTC' }, function (data) {
  console.log(data.result);
});

/**
 *  getorderbook example
 */
bittrex.getorderbook({ market: 'BTC-PIVX', depth: 10, type: 'both' }, function (data) {
  console.log(data.result);
});
