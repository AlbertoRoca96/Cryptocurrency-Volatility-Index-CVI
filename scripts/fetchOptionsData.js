const axios = require('axios');
const math = require('mathjs');
const fs = require('fs');
const moment = require('moment');

// Ensure the data directory exists
const dataDirectory = './data';
if (!fs.existsSync(dataDirectory)){
    fs.mkdirSync(dataDirectory);
}

const S = 50000; // Current spot price of Bitcoin
const r = 0.01;  // Risk-free interest rate
const T = 30 / 365; // Time to expiration in years

async function fetchOptionsData() {
  try {
    const response = await axios.get('https://www.deribit.com/api/v2/public/get_instruments', {
      params: {
        currency: 'BTC',
        kind: 'option'
      }
    });

    const options = response.data.result;
    const volatilityData = options.map(option => {
      const iv = calculateImpliedVolatility(option.last_price, S, option.strike, T, r);
      return {
        strike: option.strike,
        implied_volatility: iv
      };
    });

    // Save data to 'data/cvi.json'
    fs.writeFileSync('data/cvi.json', JSON.stringify(volatilityData, null, 2));
  } catch (error) {
    console.error('Error fetching options data:', error);
  }
}

function calculateImpliedVolatility(optionPrice, S, K, T, r) {
  let sigma = 0.2; // Initial guess
  const tolerance = 0.0001;
  let price = 0;
  let diff = 0;

  while (diff > tolerance) {
    price = blackScholesCallPrice(S, K, T, r, sigma);
    diff = Math.abs(optionPrice - price);
    sigma += 0.001;
  }
  return sigma;
}

function blackScholesCallPrice(S, K, T, r, sigma) {
  const d1 = (math.log(S / K) + (r + 0.5 * math.pow(sigma, 2)) * T) / (sigma * math.sqrt(T));
  const d2 = d1 - sigma * math.sqrt(T);
  return S * math.cdf(d1) - K * math.exp(-r * T) * math.cdf(d2);
}

fetchOptionsData();
