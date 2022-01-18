const config = require('./config');
const { INFO, ERROR, WARNING } = require('./logs');
const { FormatSize, TimeDeltaH, FormatPriceFIL, FormatPriceUSD, ToFIL, ToUSD, IsValidPriceFIL, ConvertToTBPrice } = require('./utils');
const { Lotus } = require("./lotus");
const { MinersClient } = require("./miners-client");
const { ISOCodeToRegion } = require("./location");
const CoinMarketCap = require('coinmarketcap-api')

var BigNumber = require('bignumber.js');

const coinMarketCap = new CoinMarketCap(config.bot.coinmarketcap_apikey);

let stop = false;
let lotus = new Lotus(config.bot.lotus_api);
let locationMap = new Map();
let minersSet = new Set();


async function RefreshMinersList() {
    let minersClient_FG = new MinersClient(config.bot.miners_api_fg);
    let minersClient_RS = new MinersClient(config.bot.miners_api_rs);

    const miners_fg = await minersClient_FG.GetMiners();

    for (const m_fg of miners_fg) {
        minersSet.add(m_fg.miner);
    }

    const miners_rs = await minersClient_RS.GetMiners();

    for (const m_rs of miners_rs) {
        if (m_rs.isoCode) {
            locationMap.set(m_rs.address, m_rs.isoCode);
        }
        
        minersSet.add(m_rs.address);
    }
}

async function GetFILPrice() {
    let price = undefined;

    try {
        const response = await coinMarketCap.getQuotes({symbol: 'FIL', convert: 'USD'});
        if (response?.data?.FIL?.quote?.USD?.price) {
            price = response?.data?.FIL?.quote?.USD?.price;
            INFO(`GetFILPrice ${price} USD`);
        } else {
            WARNING(`GetFILPrice response : ${JSON.stringify(response)}`);
        }
    } catch (e) {
        INFO(`GetFILPrice -> ${e}`);
    }

    return price;
}

async function GetMinersPriceInfo() {
    let result = [];

    const miners = Array.from(minersSet);

    /*const miners = [
       'f0152747',
        'f0673645',
       'f01033857',
       'f0143858',
        'f021255',
        'f0700033',
       'f042558',
       'f023198',
       'f0151366',
        'f01016198',
        'f0112087',
        'f01072221',
        'f0110567',
        'f01035680',
        'f01027268',
        'f02665',
        'f0734051',
        'f0828066',
    ];*/

    INFO(`GetMinersPriceInfo for ${miners?.length} miners`);

    if (miners?.length) {
        var minersSlice = miners;
        while (minersSlice.length) {
            await Promise.all(minersSlice.splice(0, config.bot.lotus_api_rps).map(async (miner) => {
                try {
                    let peerId = (await lotus.StateMinerInfo(miner))?.data?.result?.PeerId;
                    let power = (await lotus.StateMinerPower(miner))?.data?.result?.MinerPower?.QualityAdjPower;

                    if (!power || !peerId) {
                        INFO(`GetMinersPriceInfo[${miner}] power: ${power}, peerId: ${peerId} skip, invalid power or peerId`);
                    } else {
                        let ask = await lotus.ClientQueryAsk(peerId, miner);
                        if (ask?.data?.result?.Price) {
                            let price = ask?.data?.result?.Price;
                            let region = ISOCodeToRegion(locationMap.get(miner));

                            result.push({
                                miner: miner,
                                power: power,
                                price: price,
                                region: region,
                            });


                            INFO(`GetMinersPriceInfo[${miner}] power: ${power}, peerId: ${peerId}, price: ${price}`);
                        } else {
                            INFO(`GetMinersPriceInfo[${miner}] power: ${power}, peerId: ${peerId} skip, no price info`);
                        }
                    }

                } catch (e) {
                    if (e?.code != 'ECONNABORTED') {
                        INFO(`GetMinersPriceInfo[${miner}] -> ${e}`);
                    } else {
                        INFO(`GetMinersPriceInfo[${miner}] skip, no price info`);
                    }
                }
            }));

            if (stop) {
                break;
            }

        }
    }

    return result;
}

async function CalculateAverages(miners) {
    let result = [];
    let filPrice = await GetFILPrice();
    let filPriceBN = new BigNumber(filPrice);

    let globalPrice = new BigNumber(0);
    let asiaPrice = new BigNumber(0);
    let northAmericaPrice = new BigNumber(0);
    let otherPrice = new BigNumber(0);
    let europePrice = new BigNumber(0);

    let globalCount = 0;
    let asiaCount = 0;
    let northAmericaCount = 0;
    let otherCount = 0;
    let europeCount = 0;

    if (!filPrice || filPriceBN.isNaN()) {
        ERROR(`CalculateAverages[${m.miner}] invalid FIL price ${filPrice}`);
        return result;
    }

    for (const m of miners) {
        let priceUSD = ToUSD(ToFIL(m.price), filPrice);
        let priceUSD_BN = new BigNumber(ConvertToTBPrice(priceUSD));

        if (!priceUSD_BN.isNaN() && IsValidPriceFIL(m.price)) {
            switch (m.region) {
                case 'Other':
                    globalPrice = globalPrice.plus(priceUSD_BN);
                    otherPrice = otherPrice.plus(priceUSD_BN);
                    globalCount++;
                    otherCount++;
                    break;
                case 'Europe':
                    globalPrice = globalPrice.plus(priceUSD_BN);
                    europePrice = europePrice.plus(priceUSD_BN);
                    globalCount++;
                    europeCount++;
                    break;
                case 'Asia':
                    globalPrice = globalPrice.plus(priceUSD_BN);
                    asiaPrice = asiaPrice.plus(priceUSD_BN);
                    globalCount++;
                    asiaCount++;
                    break;
                case 'North America':
                    globalPrice = globalPrice.plus(priceUSD_BN);
                    northAmericaPrice = northAmericaPrice.plus(priceUSD_BN);
                    globalCount++;
                    northAmericaCount++
                    break;
                default:
                    ERROR(`CalculateAverages[${m.miner}] invalid region ${m.region}`);
            }

            result.push({
                miner: m.miner,
                power: FormatSize(m.power),
                priceFIL: FormatPriceFIL(ConvertToTBPrice(m.price)),
                priceUSD: FormatPriceUSD(ConvertToTBPrice(priceUSD)),
                priceGiB_attoFIL: m.price,
                region: m.region,
            });
        }
    }

    return {
        FILPrice: filPriceBN.decimalPlaces(2).toFixed(),
        Global: { 
            price: globalPrice.dividedBy(globalCount).decimalPlaces(8).toFixed(),
            count: globalCount,
        },
        Asia: {
            price: asiaPrice.dividedBy(asiaCount).decimalPlaces(8).toFixed(),
            count: asiaCount,
        },
        NorthAmerica: {
            price: northAmericaPrice.dividedBy(northAmericaCount).decimalPlaces(8).toFixed(),
            count: northAmericaCount,
        },
        Other: {
            price: otherPrice.dividedBy(otherCount).decimalPlaces(8).toFixed(),
            count: otherCount,
        },
        Europe: {
            price: europePrice.dividedBy(europeCount).decimalPlaces(8).toFixed(),
            count: europeCount,
        },
        miners: result
    };
}

const pause = (timeout) => new Promise(res => setTimeout(res, timeout * 1000));

const mainLoop = async _ => {
    try {
        INFO('FilMarket Bot start');

        while (!stop) {
            await RefreshMinersList();
    
            let miners = await GetMinersPriceInfo();
            let data = await CalculateAverages(miners);

            console.log(data);
            console.log('miners', data.miners.length);
            console.log('FILPrice', data.FILPrice);
            console.log('Global', data.Global);
            console.log('Asia', data.Asia);
            console.log('NorthAmerica', data.NorthAmerica);
            console.log('Other', data.Other);
            console.log('Europe',data.Europe);

            stop = true;

            INFO(`Pause for 60 seconds`);
            await pause(60);
        }
        
    } catch (error) {
        ERROR(`[MainLoop] error :`);
        console.error(error);
        ERROR(`Shutting down`);
        process.exit(1);
    }
}

mainLoop();

function shutdown(exitCode = 0) {
    stop = true;
    setTimeout(() => {
        INFO(`Shutdown`);
        process.exit(exitCode);
    }, 3000);
}
//listen for TERM signal .e.g. kill
process.on('SIGTERM', shutdown);
// listen for INT signal e.g. Ctrl-C
process.on('SIGINT', shutdown); 