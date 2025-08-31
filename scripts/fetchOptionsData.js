const axios = require('axios');
const math = require('mathjs');
const fs = require('fs');
const moment = require('moment');

// Ensure the docs directory exists
const docsDirectory = './docs'; 
if (!fs.existsSync(docsDirectory)){
    fs.mkdirSync(docsDirectory);
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

    // Log the raw API response for debugging
    console.log('API Response:', response.data);

    const options = response.data.result;
    const volatilityData = options.map(option => {
      if (option.last_price && option.strike) {
        const iv = calculateImpliedVolatility(option.last_price, S, option.strike, T, r);

        // Log the strike, last price, and implied volatility for debugging
        console.log(`Strike: ${option.strike}, Last Price: ${option.last_price}, IV: ${iv}`);

        return {
          strike: option.strike,
          implied_volatility: iv
        };
      } else {
        console.log(`Invalid data for option: ${JSON.stringify(option)}`);
        return null;  // Ignore invalid options
      }
    }).filter(item => item !== null);  // Remove invalid entries

    // Log the final volatility data before writing to file
    console.log('Writing to docs/cvi.json:', JSON.stringify(volatilityData, null, 2));

    // Save the data to 'docs/cvi.json'
    fs.writeFileSync('docs/cvi.json', JSON.stringify(volatilityData, null, 2));
    console.log('CVI data saved to docs/cvi.json');

  } catch (error) {
    console.error('Error fetching options data:', error);
  }
}

function calculateImpliedVolatility(optionPrice, S, K, T, r) {
  let sigma = 0.2;  // Initial guess
  const tolerance = 0.0001;
  let price = 0;
  let diff = 1;  // Initial difference to start the loop
  let iterations = 0;
  const maxIterations = 100;

  // Use a better convergence check, stopping after a reasonable number of iterations
  while (diff > tolerance && iterations < maxIterations) {
    price = blackScholesCallPrice(S, K, T, r, sigma);
    diff = Math.abs(optionPrice - price);
    sigma += 0.001;
    iterations++;
  }

  if (iterations === maxIterations) {
    console.warn(`Implied volatility calculation did not converge for option price ${optionPrice}`);
  }

  return sigma;
}

function blackScholesCallPrice(S, K, T, r, sigma) {
  const d1 = (math.log(S / K) + (r + 0.5 * math.pow(sigma, 2)) * T) / (sigma * math.sqrt(T));
  const d2 = d1 - sigma * math.sqrt(T);
  
  // Ensure math.cdf() is available or use an alternative
  return S * math.cdf(d1) - K * math.exp(-r * T) * math.cdf(d2);
}

fetchOptionsData();
