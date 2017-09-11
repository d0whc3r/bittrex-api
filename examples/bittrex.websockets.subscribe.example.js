const Bittrex = require('../bittrex-api');

const bittrex = Bittrex({
  'verbose': true,
});

console.log('Connecting ....');
bittrex.websockets.subscribe(['BTC-ETH', 'BTC-SC', 'BTC-ZEN'], function (data, wsclient) {
  if (data.M === 'updateExchangeState') {
    data.A.forEach(function (data_for) {
      console.log('Market Update for ' + data_for.MarketName, data_for);
    });
  }
});
