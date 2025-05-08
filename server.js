const express = require('express');
const fetch = require('node-fetch').default;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'okhttp/4.9.3';

// helper: POST JSON
async function postJSON(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}: ${txt}`);
  }
  return res.json();
}

// 1) lookup station mask → {id,name}
async function searchStation(mask) {
  const body = {
    iLang: 1,
    sMask: mask,
    iMaxCount: 5,
    sAppID: '{A6AB5B3E-8A7E-4E84-9DC8-801561CE886F}',
    sUserDesc: '294|34|Google sdk_gphone64_x86_64|^|546338e6-5fa8-8c06-0000-0196a7501a71|en|US|440|1080|2154|2.13.3',
  };
  const json = await postJSON(
    'https://ipws.cdis.cz/IP.svc/SearchGlobalListItemInfoExt',
    body
  );
  const item = (json.d || [])[0]?.oItem;
  if (!item) throw new Error(`Station not found: ${mask}`);
  return { id: item.iListID, name: item.sName };
}

// 2) createSession → sessionID
async function createSession() {
  const body = {
    iLang: 1,
    sAppID: '{A6AB5B3E-8A7E-4E84-9DC8-801561CE886F}',
    sUserDesc: '294|34|Google sdk_gphone64_x86_64|^|546338e6-5fa8-8c06-0000-0196a7501a71|en|US|440|1080|2154|2.13.3',
    sUser: '',
    sPwd: '',
    iTokenType: 1,
    oRegisterNotificationsSettings: {
      iNotificationMask: 2047,
      iInitialAdvance: 30,
      iDelayLimit: 5,
      iChangeAdvance: 5,
      iGetOffAdvance: 5,
    },
  };
  const json = await postJSON(
    'https://ipws.cdis.cz/IP.svc/CreateSession',
    body
  );
  return json.d?.sSessionID;
}

// 3) searchJourneys → { handle, connections[] }
async function searchJourneys(sessionID, from, to, depMs, travelClass, age) {
  const body = {
    iLang: 1,
    sSessionID: sessionID,
    oFrom: { iListID: from.id, sName: from.name },
    oTo:   { iListID: to.id,   sName: to.name   },
    aoVia: [],
    aoChange: [],
    dtDateTime: `/Date(${depMs})/`,
    bIsDep: true,
    oConnParms: { iSearchConnectionFlags: 0, iCarrier: 2 },
    iMaxObjectsCount: 0,
    iMaxCount: 8,
    oPriceRequestClass: { iClass: travelClass, bBusiness: false },
    aoPassengers: [{ oPassenger: { iPassengerId: 5 }, iCount: 1, iAge: age }],
  };

  const json = await postJSON(
    'https://ipws.cdis.cz/IP.svc/SearchConnectionInfo1',
    body
  );
  const d = json.d;
  if (!d) throw new Error('Malformed journey response');
  return {
    handle: d.iHandle,
    connections: d.oConnInfo?.aoConnections || [],
  };
}

// 4) getPrices → [{ czk, eur }, …]
async function getPrices(sessionID, handle, connIDs, travelClass, age, czkRate) {
  const body = {
    iLang: 1,
    sSessionID: sessionID,
    iHandle: handle,
    aiConnID: connIDs,
    oPriceRequest: {
      aoPassengers: [{ oPassenger: { iPassengerId: 5 }, iCount: 1, iAge: age }],
      iConnHandleThere: 0,
      iConnIDThere: 0,
      oClass: { iClass: travelClass, bBusiness: false },
      iDocType: 1,
    },
    bStopIfAgeError: true,
  };
  const json = await postJSON(
    'https://ipws.cdis.cz/IP.svc/GetConnectionsPrice',
    body
  );
  const list = json.d || [];
  return list.map(item => {
    // cents of CZK → CZK → EUR
    const czk = (item.iPrice || 0) / 100.0;
    const eur = czk / czkRate;
    return {
      czk: Number(czk.toFixed(2)),
                  eur: Number(eur.toFixed(2)),
    };
  });
}


// 5) CZK rate
async function fetchCzkRate() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?symbols=CZK');
  const json = await res.json();
  return json.rates?.CZK || 1;
}

// helper: parse /Date(…)/ → ISO
function parseDate(raw) {
  const ms = parseInt(raw.replace(/\D/g, ''), 10);
  return new Date(ms).toISOString();
}

app.get('/connections', async (req, res) => {
  try {
    const { from, to, dep, age } = req.query;
    // avoid reserved word
    const cls = Number(req.query['class'] || 2);
    if (!from || !to || !dep) {
      return res.status(400).json({ error: 'Missing from, to, or dep' });
    }

    // 1) station lookups in parallel
    const [fromSt, toSt] = await Promise.all([
      searchStation(from),
                                             searchStation(to),
    ]);

    // 2) session
    const sessionID = await createSession();

    // 3) journeys + handle
    const { handle, connections } = await searchJourneys(
      sessionID,
      fromSt,
      toSt,
      Number(dep),
                                                         cls,
                                                         Number(age || -1)
    );

    // 4) exchange rate
    const czkRate = await fetchCzkRate();

    // 5) prices
    const connIDs = connections.map(c => c.iID);
    const prices = await getPrices(
      sessionID,
      handle,
      connIDs,
      cls,
      Number(age || -1),
                                   czkRate
    );

    // 6) assemble output
    const out = connections.map((c, i) => ({
      id: c.iID,
      priceCzk: prices[i].czk,
      priceEur: prices[i].eur,
      transfers: c.aoTrains.length - 1,
      legs: c.aoTrains.map(leg => ({
        depTime: parseDate(leg.dtDateTime1),
        arrTime: parseDate(leg.dtDateTime2),
        depName: leg.sStationName1,
        destName: leg.sStationName2,
        lineName: [leg.sType, leg.sNum1, leg.sNum2, leg.sNum3]
          .filter(Boolean)
          .join(' ')
          .trim(),
      })),
    }));

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () =>
console.log(`Server running at http://localhost:${PORT}/connections`)
);
