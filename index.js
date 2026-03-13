// use strict;

/**
 * @typedef PackState
 * @type {object}
 * @property {number} balance - The current balance of the pack.
 * @property {number} lastRefillAt - The timestamp of the last refill.
 * @property {string} nonce - A unique nonce for the pack state.
 * @property {string} sig - The signature of the pack state.
 */

/**
 * @typedef Card
 * @type {object}
 * @property {number} id - The unique ID of the card.
 * @property {string} title - The title of the card.
 * @property {string} rarity_rank - The rarity rank of the card (e.g., "SSR").
 */

const RETRY_ATTEMPTS = 5;
const RETRY_INIT_DELAY = 5000; // 5 seconds
const RETRY_MAX_DELAY = 60000; // 1 minute
const RETRY_FACTOR = 1.5 // Exponential backoff factor

const DELAY_MIN = 3000; // 3 seconds
const DELAY_MAX = 10000; // 10 seconds

const debug = (ns, ...msg) => console.debug(`[DBG] ${ns.padStart(5, ' ')} |`, ...msg);
const info = (ns, ...msg) => console.info(`[INF] ${ns.padStart(5, ' ')} |`, ...msg);
const warn = (ns, ...msg) => console.warn(`[WRN] ${ns.padStart(5, ' ')} |`, ...msg);
const error = (ns, ...msg) => console.error(`[ERR] ${ns.padStart(5, ' ')} |`, ...msg);

/**
 * @param {DOMException} err
 * @returns {Error}
 */
const toError = (err) => {
  const name = err?.name ?? "UnknownError";
  const message = err?.message ?? "Unknown error opening database";
  return new Error(`${name}: ${message}`)
}

/**
 * @param {number} ms
 * @param {number} times
 * @returns {Promise<void>}
 */
const delay = (ms, times = 1) => Math.min(ms * Math.pow(times <= 1 ? 1 : times, RETRY_FACTOR), RETRY_MAX_DELAY);
const randomDelay = () => Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @returns {Promise<IDBDatabase>}
 */
const getDB = async () => {
  return new Promise((resolve, reject) => {
    debug('DB', 'Opening database...');
    const req = indexedDB.open("wiki-gacha-db")
    req.onsuccess = function () {
      debug('DB', 'Database opened successfully');
      resolve(this.result);
    }
    req.onerror = function () {
      const err = toError(this.error);
      error('DB', err);
      reject(err);
    }
  })
}

/**
 * @param {IDBDatabase} db
 * @param {string} name
 * @param {IDBTransactionMode} mode
 * @returns {IDBObjectStore}
 */
const getStore = (db, name, mode = 'readonly') => {
  debug('DB', 'Creating transaction...');
  const trx = db.transaction(name, mode);
  return trx.objectStore(name);
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
const getDBRequest = async (req) => {
  return new Promise((resolve, reject) => {
    req.onsuccess = function () {
      resolve(this.result);
    }
    req.onerror = function () {
      const err = toError(this.error);
      reject(err);
    }
  });
}

/**
 * @param {IDBDatabase} db
 * @returns {Promise<PackState>}
 */
const loadPackState = async (db) => {
  const store = getStore(db, 'user_data', 'readonly');
  return {
    balance: await getDBRequest(store.get('en:pack_balance')) ?? 10,
    lastRefillAt: await getDBRequest(store.get('en:pack_last_refill_at')) ?? Date.now() + 30000,
    nonce: await getDBRequest(store.get('en:pack_nonce')) ?? '34323458b3a9cfb19add3ffe72824fa0',
    sig: await getDBRequest(store.get('en:pack_sig')) ?? 'ec74591b86bdbb3b4a166417b13efd4c78e1c7203ea42e88159607b0e2d6ef78',
  }
}

/**
 * @param {IDBDatabase} db
 */
const updateTrophies = async (db) => {
  const store = getStore(db, 'user_data', 'readwrite');
  const trophies = [
    'beginner_luck', 'gacha_addict', 'routine', 'whale', 'leviathan', 
    'collector', 'curator', 'collection_5000', 'dust_collector', 'shiny', 
    'super_rare', 'ultra_luck', 'legend', 'desire_sensor', 'god_whim', 
    'double_rainbow', 'miracle', 'rainbow', 'full_house', 'all_uc', 
    'dupe_2', 'dupe_3', 'dupe_5', 'elite', 'legendary_vault', 'glass_cannon', 
    'fortress', 'heavy_hitter', 'iron_wall', 'perfect_being', 'quality_zero', 
    'weakest', 'origin', 'lucky_seven', 'long_winded', 'minimalist', 'katakana', 
    'mirror', 'step', 'ads', 'team_grade_c_win', 'team_grade_uc_win', 
    'team_grade_r_win', 'team_grade_sr_win', 'team_grade_ssr_win', 
    'team_grade_ur_win', 'team_grade_lr_win', 'raid_clear_1', 'raid_clear_3', 
    'raid_clear_5', 'raid_clear_10'
  ];
  info('DB', 'Adding trophies to database...');
  const output = await getDBRequest(store.put(trophies, 'en:trophies'));
  info('DB', 'Trophies added', output);
}

/**
 * @param {IDBDatabase} db
 */
const updateCardCount = async (db) => {
  const store = getStore(db, 'cards_en', 'readwrite');
  const keys = await getDBRequest(store.getAllKeys());
  for (const key of keys) {
    if (typeof key === 'number') {
      const card = await getDBRequest(store.get(key));
      if (card && card.count === undefined) {
        card.count = 1;
        await getDBRequest(store.put(card));
      }
    }
  }
  info('DB', `There are currently ${keys.length} cards in the database.`);
}

/**
 * @param {IDBObjectStore} store
 * @param {Array<Card>} cards
 * @returns {Promise<Array<Card>>}
 */
const addCards = async (store, cards) => {
  const promises = await Promise.all(cards.map(async (card) => {
    debug('DB', `Adding card ${card.id} to database...`);
    try {
      await getDBRequest(store.put(Object.assign({ count: 1 }, card)));
      debug('DB', `Card ${card.id} added successfully`);
      return card;
    } catch (err) {
      error('DB', `Error adding card ${card.id}:`, err);
      return undefined
    }
  }));

  return promises.filter(card => card !== undefined);
}

/**
 * @param {PackState} packState 
 * @returns {Promise<{cards: Array<Card>, packState: PackState}>}
 */
const fetchCards = async (packState) => {
  try {
    debug('API', 'Fetching cards from API...');
    for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
      debug('API', `Attempt #${i} to fetch cards...`);
      const resp = await fetch("https://wikigacha.com/api/gacha", {
        "headers": {
          "accept": "*/*",
          "accept-language": "en;q=0.7",
          "cache-control": "no-cache",
          "content-type": "application/json",
        },
        "referrer": "https://wikigacha.com/",
        "body": JSON.stringify({
          packState: {
            balance: packState.balance < 1 ? 1 : packState.balance,
            lastRefillAt: packState.lastRefillAt,
            nonce: packState.nonce,
            sig: packState.sig,
          },
          guaranteedSrPlus: 1,
          lang: "EN"
        }),
        "method": "POST",
      });
      if (resp.status === 429) {
        const duration = delay(RETRY_INIT_DELAY, i);
        warn('API', `Got 429, wait for ${duration} ms`);
        await wait(duration);
        continue;
      }
      if (resp.status !== 200) {
        throw new Error(`Error fetching cards: ${resp.status}`, resp.headers);
      }
      const json = await resp.json();
      debug('API', `Fetched ${json.cards.length} cards successfully`);
      return json;
    }
  } catch (err) {
    error('API', 'Error fetching cards:', err);
    throw err;
  }
}

const mainLoop = async (times = 1) => {
  info('MAIN', `Starting main loop`);
  const db = await getDB();
  let packState = await loadPackState(db);
  for (let i = 0; i < times; i++) {
    debug('MAIN', `Starting iteration #${i + 1}...`);
    debug('MAIN', 'packState', packState);

    const resp = await fetchCards(packState);
    packState = resp.packState;

    const store = getStore(db, 'cards_en', 'readwrite');
    const cards = await addCards(store, resp.cards);
    /** @type {Map<string, Card[]>} */
    const emptyMap = new Map()
    const map = cards.reduce((map, card) => map.set(card.rarity_rank, (map.get(card.rarity_rank) ?? []).concat(card)), emptyMap);
    map.forEach((cards, rarity) => {
      info('CARD', `Rarity: ${rarity.padEnd(3, ' ')} ${cards.length}`);
    });

    info('MAIN', `Iteration #${i + 1} completed, waiting ${duration} ms for next iteration...`);
    await wait(duration);
  }

  info('MAIN', 'Main loop completed');
}

// await mainLoop(1);
