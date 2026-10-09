// Descarga los precios de One Piece de TCGCSV (copia diaria de TCGPlayer) y los deja como archivos JSON
// estáticos, que es lo que lee la app. Así TCGCSV recibe una descarga al día y no una por cada móvil.
//
// Uso: node build.mjs <carpeta de salida>
//
// Archivos que genera:
//   index.json        { updated, groups: [{ id, name, abbreviation, releaseDate, cardCount }] }
//   sets/<id>.json    { id, name, dates: ['2026-10-08', ...], cards: { <nombre del producto>: { id, low, mid, market, history } } }
//
// history: precio de mercado de cada día de dates (null si ese día no había). Se conserva lo que ya había
// en la carpeta de salida, así que cada ejecución añade un día.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'

const TCGCSV_URL = 'https://tcgcsv.com'
// 68: One Piece Card Game en TCGPlayer
const CATEGORY = 68
// TCGCSV bloquea las peticiones que no identifican la aplicación
const USER_AGENT = 'OnePiecePriceFeed/1.0.0'
// TCGCSV pide una pausa entre peticiones
const REQUEST_PAUSE_MS = 150
const RETRIES = 3
// Días de precios que se conservan de cada carta
const HISTORY_DAYS = 31

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const request = async (url) => {
  for (let attempt = 1; ; attempt++) {
    await sleep(REQUEST_PAUSE_MS)

    try {
      const res = await fetch(`${TCGCSV_URL}${url}`, { headers: { 'User-Agent': USER_AGENT } })
      if(!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.text()
    } catch (e) {
      if(attempt >= RETRIES) throw e
      await sleep(2000 * attempt)
    }
  }
}

const requestJson = async (url) => {
  const data = JSON.parse(await request(url))
  if(!data.success) throw new Error(`${url}: ${JSON.stringify(data.errors)}`)
  return data.results || []
}

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return null
  }
}

// Las cartas de una expansión con su precio de hoy; se añade a lo que ya había publicado de esa expansión
const buildGroup = async (group, day, previous) => {
  const products = await requestJson(`/tcgplayer/${CATEGORY}/${group.groupId}/products`)
  const prices = await requestJson(`/tcgplayer/${CATEGORY}/${group.groupId}/prices`)

  // Algún producto tiene dos precios (normal y foil): el que tenga precio de mercado
  const priceByProduct = new Map()
  for (const price of prices) {
    const current = priceByProduct.get(price.productId)
    if(!current || (!current.marketPrice && price.marketPrice)) priceByProduct.set(price.productId, price)
  }

  const previousDates = previous?.dates || []
  const dates = [...previousDates.filter(e => e !== day), day].slice(-HISTORY_DAYS)

  const cards = {}
  const numbers = new Set()

  for (const product of products) {
    // Sin número de carta: sobres, cajas, fundas...
    const number = product.extendedData?.find(e => e.name === 'Number')?.value
    if(!number) continue

    numbers.add(number)
    // Dos productos con el mismo nombre: se queda el primero
    if(cards[product.name]) continue

    const price = priceByProduct.get(product.productId)
    const market = price?.marketPrice ?? null
    const previousHistory = previous?.cards?.[product.name]?.history || []

    cards[product.name] = {
      id: product.productId,
      low: price?.lowPrice ?? null,
      mid: price?.midPrice ?? null,
      market,
      history: dates.map(date => date === day ? market : previousHistory[previousDates.indexOf(date)] ?? null),
    }
  }

  return { id: group.groupId, name: group.name, dates, cardCount: numbers.size, cards }
}

const main = async () => {
  const out = process.argv[2]
  if(!out) throw new Error('Uso: node build.mjs <carpeta de salida>')

  // Momento de la última actualización de TCGCSV: si es la que ya está publicada, no hay nada que hacer
  const updated = (await request('/last-updated.txt')).trim()
  const published = await readJson(path.join(out, 'index.json'))
  const changed = published?.updated !== updated || !!process.env.FORCE

  if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)

  if(!changed){
    console.log(`Sin cambios: ya están publicados los precios de ${updated}`)
    return
  }

  const day = updated.slice(0, 10)
  let groups = await requestJson(`/tcgplayer/${CATEGORY}/groups`)

  // Para pruebas: GROUPS=3188,3189 descarga solo esas expansiones
  if(process.env.GROUPS) groups = groups.filter(e => process.env.GROUPS.split(',').includes(String(e.groupId)))

  await mkdir(path.join(out, 'sets'), { recursive: true })

  const index = []
  const failed = []

  for (const group of groups) {
    const file = path.join(out, 'sets', `${group.groupId}.json`)
    const previous = await readJson(file)
    let built = null

    try {
      built = await buildGroup(group, day, previous)
      await writeFile(file, JSON.stringify(built))
    } catch (e) {
      // Si una expansión falla se queda publicada la de ayer
      failed.push(group.name)
      console.log(`::warning::${group.name}: ${e.message}`)
    }

    const cardCount = built?.cardCount ?? previous?.cardCount
    if(cardCount === undefined) continue

    index.push({ id: group.groupId, name: group.name, abbreviation: group.abbreviation, releaseDate: group.publishedOn, cardCount })
  }

  if(index.length == 0) throw new Error('No se ha podido descargar ninguna expansión')

  // Con expansiones fallidas no se marca el día como publicado: la siguiente ejecución lo vuelve a intentar
  await writeFile(path.join(out, 'index.json'), JSON.stringify({ updated: failed.length > 0 ? `${updated} (incompleto)` : updated, groups: index }))

  console.log(`${index.length} expansiones publicadas con los precios de ${updated}${failed.length > 0 ? ` · ${failed.length} con fallos` : ''}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
