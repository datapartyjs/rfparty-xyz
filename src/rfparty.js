//import { point } from 'leaflet'
//import { scan } from 'node-wifi'

//const Debug = require('debug')('rfparty')
const Leaflet = require('leaflet')
const Pkg = require('../package.json')
const JSONPath = require('jsonpath-plus').JSONPath
const reach = require('./reach')
const Loki = require('lokijs')
const moment = require('moment')
const DeviceIdentifiers = require('./device-identifiers')

const TILE_SERVER_DEFAULT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_SERVER_DARK = 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png'
const TILE_SERVER_LIGHT = 'https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png'

async function delay(ms=100){
  return new Promise((resolve, reject)=>{
    setTimeout(resolve, ms)
  })
}



/**
 * 
 * BLE
 * 
 * Bool
 *  - connectable [ true / false ]
 *  - address_type [ public / random ]
 * Int
 *  - mtu
 *  - rssi
 *  - duration
 * 
 * DateTime or DateTimeRange
 *  - timestamp
 *  - duration
 * 
 * String
 *  - localname
 *  - company
 *  - product
 *  - services
 *
 *  Hex String
 *  - address
 *  - companyCode
 *  - appleContinuityTypeCode
 *  - 
 */


export class RFParty {
  constructor(divId) {

    this.showAllTracks = false
    this.showAwayTracks = false

    this.map = Leaflet.map(divId).setView([47.6, -122.35], 13)

    Leaflet.tileLayer(TILE_SERVER_DARK, {}).addTo(this.map);

    this.db = new Loki('session')

    // build session db

    this.db.addCollection('locationTrack', {
      indices: ['timestamp', 'lat', 'lon', 'filename', 'source']
    })

    this.db.addCollection('homeState', {
      indices: ['timestamp', 'filename']
    })

    this.db.addCollection('awayTime', {
      indices: ['starttime', 'endtime',
        'bounds.min.x', 'bounds.min.y',
        'bounds.max.x', 'bounds.max.y'
      ]
    })

    this.db.addCollection('ble', {
      indices: ['firstseen', 'lastseen', 'address', 'duration', 'advertisement.localName',
        'connectable', 'addressType', 'services', 'hasUnknownService',
        'company', 'product', 'companyCode', 'productCode', 'appleContinuityTypeCode', 'appleIp']
    })

    this.db.addCollection('appleDevices', {
      indices: ['address', 'continuityCode', 'ip']
    })

    this.mobileSegments = []

    this.srcs = {}

    this.deviceLayers = {}
    this.searchResults = null

    this.scanDb = null
    //this.gpx = {}
    this.gpxLines = {}
  }

  async start() {
    console.log('starting')

    let awayTime = this.db.getCollection('awayTime').find()

    console.log('found', awayTime.length, 'away time periods')

    let devices = []

    for (let away of awayTime) {
      let track = this.getTrackByTime(away.starttime, away.endtime)

      if(track.length == 0){continue}

      let latlngs = this.trackToLatLonArray(track)

      console.log('\trendering', latlngs.length, 'track points')

      if(this.showAwayTracks){
        Leaflet.polyline(latlngs, { color: 'yellow', opacity: 0.74, weight: '2' }).addTo(this.map)
      }

      let bleDevices = this.db.getCollection('ble').find({
        lastseen: {
          $between: [away.starttime, away.endtime]
        },
        duration: {
          $gt: 30*60000
        }
      })

      devices = devices.concat(bleDevices)

    }
    
    this.renderBleDeviceList(devices)
    //refine ble & wifi observations
    //    compute firstSeen & lastSeen


  }

  handleSearch(tokens){
    let devices = null
    let term = tokens.slice(1).join(' ')
    switch(tokens[0]){
      case 'name':
      case 'localname':
        console.log('select by name', tokens)
        devices = this.db.getCollection('ble').find({
          'advertisement.localName':  {'$contains':  term }
        })

        console.log('term['+term+']')



        break
      case 'company':
        console.log('select by company', tokens)
        devices = this.db.getCollection('ble').find({
          'company':  {'$contains':  term }
        })
        break

      case 'product':
        console.log('select by product', tokens)
        
        devices = this.db.getCollection('ble').find({
          'product':  {'$contains':  term }
        })
        break

      case 'unknown-service':
        devices = this.db.getCollection('ble').find({
          'hasUnknownService':  {'$exists': true }
        })
        break
      case 'service':
        console.log('select by service', tokens)
        let possibleServices = RFParty.reverseLookupService(term)
        console.log('possible', possibleServices)
        devices = this.db.getCollection('ble').find({
          'services':  {'$containsAny':  possibleServices }
        })
        break

      case 'appleIp':
        console.log('select by appleIp', tokens)
        if(tokens.length < 2){
          devices = this.db.getCollection('ble').find({
            'appleIp':  {'$exists': true }
          })
        }
        else{
          devices = this.db.getCollection('ble').find({
            'appleIp':  {'$contains':  term }
          })
        }
        break

      case 'random':
        devices = this.db.getCollection('ble').find({
          'addressType':  {'$eq':  'random' }
        })
        break
      case 'public':
        devices = this.db.getCollection('ble').find({
          'addressType':  {'$eq':  'public' }
        })
        break
      case 'connectable':
        devices = this.db.getCollection('ble').find({
          'connectable':  {'$eq':  true }
        })
        break
      case 'duration':
        devices = this.db.getCollection('ble').find({
          duration: {
            $gt: 30*60000
          }
        })
        break

      default:
        console.log('unknown select type', tokens[0])
        break
    }

    console.log(devices)

    if(devices != null){
      this.renderBleDeviceList(devices)
    }
  }


  renderBleDeviceList(bleDevices){
    console.log('\trendering', bleDevices.length, 'ble devices')

    if(this.searchResults != null){
      this.map.removeLayer(this.searchResults)
      delete this.searchResults
    }

    let layer = Leaflet.layerGroup()

    for (let dev of bleDevices) {

      //if(dev.duration < 30*60000){ continue }

      let pt = this.getTrackPointByTime(dev.lastseen)

      if (pt) {
        let lastCircle = Leaflet.circle([pt.lat, pt.lon], { color: 'white', radius: 10, fill:true, weight:1, opacity: 1, fillOpacity:0.3, fillColor:'white' })
        layer.addLayer(lastCircle)

        let onclick = (event)=>{
          this.handleClick({
            event,
            type: 'ble', 
            value: dev.address,
            timestamp: dev.lastseen
          })
        }

        lastCircle.on('click', onclick)

        let firstPt = this.getTrackPointByTime(dev.firstseen)

        if(firstPt){
          let line = Leaflet.polyline([
            this.trackToLatLonArray([firstPt, pt])
          ], { color: 'blue', opacity: 0.5, weight: '5' })

          layer.addLayer(line)
          line.on('click', onclick)
          

          let firstCircle = Leaflet.circle([firstPt.lat, firstPt.lon], { color: 'red', radius: 5, fill:true, weight:1, opacity: 1 })

          layer.addLayer(firstCircle)
          firstCircle.on('click', (event)=>{
            this.handleClick({
              event,
              type: 'ble', 
              value: dev.address,
              timestamp: dev.firstseen
            })
          })
        }
      }
    }

    this.searchResults = layer
    layer.addTo(this.map)
  }

  getBLEDevice(mac){
    return this.db.getCollection('ble').find({address:mac})[0]
  }

  updateDeviceInfoHud(){
    let devices = Object.keys( this.deviceLayers )
    if(devices.length == 0){
      let deviceInfo = document.getElementsByClassName('device-info')
      deviceInfo.classList.add('hidden')
    } else {
      
      

      let device = this.getBLEDevice(devices[0])

      console.log(device)


      //document.getElementById('device-info-mac').textContent = reach(device, 'address')
      //document.getElementById('device-info-name').textContent = reach(device, 'advertisement.localName')


      let companyText = ''

      if(reach(device, 'company')){
        companyText=reach(device, 'company') + '(' + reach(device, 'companyCode') + ')'
      }
      else if(reach(device, 'companyCode')){
        companyText='Unknown Company' + '(0x' + reach(device, 'companyCode') + ')'
      }

      if(reach(device, 'product')){
        if(companyText.length > 0){
          companyText+='\n'
        }
        companyText+=reach(device, 'product')
      }

      document.getElementById('device-info-address').textContent = reach(device, 'address')

      if(reach(device, 'advertisement.localName')){
        document.getElementById('device-info-name').textContent = reach(device, 'advertisement.localName')
        window.MainWindow.showDiv('device-info-name')
      }
      else{
        window.MainWindow.hideDiv('device-info-name')
      }


      document.getElementById('device-info-company').textContent = companyText

      //document.getElementById('device-info-company').textContent = companyText
      
      //document.getElementById('device-info-product').textContent = productText

      let serviceText = ''

      if(device.appleContinuityTypeCode){
        let appleService = RFParty.lookupAppleService( device.appleContinuityTypeCode)
        if(appleService){
          serviceText+=  'Apple ' + appleService + '(0x' + device.appleContinuityTypeCode + '); \n'
        }
        else{
          serviceText+=  'Apple ' + '0x' + device.appleContinuityTypeCode + '; \n'
        }
      }
      

      if(device.appleIp){
        serviceText+=  'Apple IP ' + device.appleIp + '; \n'
      }

      device.advertisement.serviceUuids.map(uuid=>{
        let name = RFParty.lookupDeviceUuid(uuid)

        if(name){
          serviceText += name + '(0x' + uuid + '); \n'
        } else {
          serviceText += '0x' + uuid + '; \n'
        }
      })

      document.getElementById('device-info-services').textContent = serviceText

      //! @todo

      let deviceInfo = document.getElementsByClassName('device-info')[0]
      deviceInfo.classList.remove('hidden')
    }
  }


  handleClick({type, value, timestamp, event}){
    console.log('clicked type=', type, value, timestamp, event)

    if(type == 'ble'){

      console.log('shift', event.originalEvent.shiftKey)

      //this.selectedLayers = [ value ]

      let layer = Leaflet.layerGroup()

      let device = this.getBLEDevice(value)

      let devicePathLL = []

      for(let observation of device.seen){
        let pt = this.getTrackPointByTime(observation.timestamp)

        if(pt){ 
          devicePathLL.push([ pt.lat, pt.lon ])
          let circle = Leaflet.circle([pt.lat, pt.lon], { color: 'green', radius: 8, fill:true, weight:1, opacity: 0.9 })
          layer.addLayer(circle)
        }
      }

      if(devicePathLL.length > 0){
        let line = Leaflet.polyline(devicePathLL, { color: 'green', opacity: 0.9, weight: '4' })
        layer.addLayer(line)
      }


      if(!event.originalEvent.shiftKey){
        for(let mac in this.deviceLayers){
          let l = this.deviceLayers[mac]
          this.map.removeLayer(l)

          delete this.deviceLayers[mac]
        }
      }

      this.deviceLayers[ value ] = layer
      layer.addTo(this.map)

      this.updateDeviceInfoHud()
    }

    
  }

  getTrackPointByTime(timestamp) {
    let bestDeltaMs = null
    let bestPoint = null
    let track = this.getTrackByTime(timestamp - 60000, timestamp + 6000)

    for (let point of track) {
      let deltaMs = Math.abs(moment(point.timestamp).diff(track.timestamp))

      if (deltaMs < bestDeltaMs || bestDeltaMs == null) {
        bestDeltaMs = deltaMs
        bestPoint = point
      }
    }

    return bestPoint
  }

  getTrackByTime(starttime, endtime) {
    return this.db.getCollection('locationTrack').find({
      timestamp: {
        $between: [starttime, endtime]
      }
    })
  }

  trackToLatLonArray(track) {
    let llarr = []

    for (let point of track) {
      llarr.push([
        point.lat, point.lon
      ])
    }

    return llarr
  }

  getTrackPointsByTime(start, end) {
    let llpoints = []
    let track = this.getTrackByTime(start, end)

    for (let point of track) {
      llpoints.push(Leaflet.point(point.lat, point.lon))
    }

    return llpoints
  }

  getTrackBoundsByTime(starttime, endtime) {
    let points = this.getTrackPointsByTime(starttime, endtime)

    return Leaflet.bounds(points)
  }

  async addScanDb(serializedDb, name) {
    //console.log('opening scan db', name, '...')
    let scanDb = new Loki(name)
    scanDb.loadJSON(serializedDb)
    //console.log('opened scan db', name)


    let homeState = this.db.getCollection('homeState')
    let bleColl = this.db.getCollection('ble')
    let scanDbWifi = scanDb.getCollection('wifi')
    let scanDbHomeState = scanDb.getCollection('homeState')
    let scanDbBle = scanDb.getCollection('ble')


    let dbInfo = scanDb.listCollections()
    //console.log(dbInfo)
    let parts = scanDbHomeState.count() + scanDbBle.count() + scanDbWifi.count()
  
    
    window.loadingState.startStep('index '+name, parts)


    console.log('importing home state . . .')
    let awayObj = null
    let isAway = false
    
    let count = 0
    for (let state of scanDbHomeState.chain().find().simplesort('timestamp').data()) {
      homeState.insert({
        timestamp: state.timestamp,
        isHome: state.isHome,
        filename: name
      })
      
      window.loadingState.completePart('index '+name)

      count++
      if(count%3000 == 0){
        await delay(10)
      }

      if (!isAway && !state.isHome) {
        //! Device is now away
        awayObj = {
          starttime: state.timestamp,
          endtime: null,
          duration: null
        }

        isAway = true
      }
      else if (isAway && state.isHome) {
        //! Device is now home
        awayObj.endtime = state.timestamp
        awayObj.duration = moment(state.timestamp).diff(awayObj.starttime)

        let points = this.getTrackPointsByTime(awayObj.starttime, awayObj.endtime)

        if (points.length > 0) {
          let bounds = Leaflet.bounds(points)

          awayObj.bounds = {
            min: { x: bounds.min.x, y: bounds.min.y },
            max: { x: bounds.max.x, y: bounds.max.y }
          }

        }


        this.db.getCollection('awayTime').insert(awayObj)

        //console.log('timeaway', awayObj)
        //console.log(moment(awayObj.starttime).format(), 'to', moment(awayObj.endtime).format())

        awayObj = null
        isAway = false
      }
    }

    console.log('importing ble . . .')
    
    for (let device of scanDbBle.chain().find().data({ removeMeta: true })) {
      let start = device.seen[0].timestamp
      let end = device.seen[device.seen.length - 1].timestamp
      
      window.loadingState.completePart('index '+name)
      count++
      if(count%500 == 0){
        await delay(10)
      }

      let duration = Math.abs( moment(start).diff(end) )
      let doc = {
        firstseen: start,
        lastseen: end,
        duration,
        product: [],
        services: [],
        //localname: device.advertisement.localname,

        ...device
      }


      device.advertisement.serviceUuids.map(uuid=>{
        let found = RFParty.lookupDeviceUuid(uuid)

        if(!found){
          if(!doc.hasUnknownService){
            doc.hasUnknownService=[]
          }
          doc.hasUnknownService.push(uuid)
        }
        else if(found && found.indexOf('Product') != -1){
          doc.product = found
        }
        else if(found && found.indexOf('Service') != -1){
          doc.services.push(found)
        }
        else if (!device.advertisement.manufacturerData && found){
          doc.company = found
        }
      })

      /*if(device.advertisement.serviceUuids.length > 0){
        for(let uuid in ){
          
        }
      }*/

      if(device.advertisement.manufacturerData ){
    
    
        let dataLen = device.advertisement.manufacturerData.data.length
        let dataArr = Uint8Array.from(device.advertisement.manufacturerData.data)
        let manufacturerData = new Buffer( dataArr.buffer )
        const companyCode = manufacturerData.slice(0, 2).toString('hex').match(/.{2}/g).reverse().join('')

        doc.companyCode = companyCode
        doc.company = RFParty.lookupDeviceCompany(companyCode)
    
        if(companyCode == '004c'){
          const cm = manufacturerData.slice(2, 3).toString('hex')
          doc.appleContinuityTypeCode = cm

          let appleService = RFParty.lookupAppleService(cm)
          if(appleService){
            doc.services.push( appleService )
          }
    
          if(cm =='09'){
    
            const devIP = manufacturerData.slice( manufacturerData.length-4, manufacturerData.length )
    
            const appleIp = devIP[0] + '.'
              + devIP[1] + '.'
              + devIP[2] + '.'
              + devIP[3]
    
              doc.appleIp = appleIp
          }
    
    
          //console.log('cm', cm )
        }
      }

      bleColl.insert(doc)
    }

    for (let device of scanDbWifi.chain().find().data({ removeMeta: true })){
      window.loadingState.completePart('index '+name)

      count++
      if(count%500 == 0){
        await delay(1)
      }
    }
    
    
    
    console.log('importing wifi . . .')
    window.loadingState.completeStep('index '+name)
    
    await delay(200)
    

    //this.scanDb = scanDb
  }

  async addGpx(obj, name) {
    console.log('adding gpx', name)

    let collection = this.db.getCollection('locationTrack')

    //this.gpx[name]=obj

    const trackPoints = JSONPath({ json: obj, path: '$..trkpt' })[0]
    
    window.loadingState.startStep('index '+name, trackPoints.length)

    const latlngs = []

    let count = 0
    for (let point of trackPoints) {
      const src = reach(point, 'src.value')

      const lat = reach(point, '_attributes.lat')
      const lon = reach(point, '_attributes.lon')
      const time = moment(reach(point, 'time.value'))
      
      window.loadingState.completePart('index '+name)

      count++
      if(count%500 == 0){
        await delay(0)
      }

      collection.insert({
        filename: name,
        elevation: reach(point, 'ele.value'),
        course: reach(point, 'course.value'),
        speed: reach(point, 'speed.value'),
        source: reach(point, 'src.value'),
        timestamp: time.valueOf(),
        lat: lat,
        lon: lon
      })

      latlngs.push([lat, lon])

      if (!src) { continue }

      if (!this.srcs[src]) {
        this.srcs[src] = 1
      } {
        this.srcs[src]++
      }
    }

    //console.log('loaded gpx', name)

    if(this.showAllTracks){
      /*this.gpxLines[name] =*/ Leaflet.polyline(latlngs, { color: 'white', opacity: 0.4, weight: '2' }).addTo(this.map)
    }

    
    window.loadingState.completeStep('index '+name)
    //console.log('added gpx', name, 'with', trackPoints.length, 'points')
  }

  static get Version() {
    return Pkg.version
  }

  


  static lookupDeviceCompany(code){
    return  DeviceIdentifiers.COMPANY_IDENTIFIERS[code] 
  }
  
  static lookupAppleService(code){
    return DeviceIdentifiers.APPLE_Continuity[code]
  }
  
  static lookupDeviceUuid(uuid){
    let deviceType = null
  
    if(uuid.length == 4){
      deviceType = DeviceIdentifiers.UUID16[uuid] 
    }
    else if(uuid.length == 32){
      deviceType = DeviceIdentifiers.UUID[uuid] 
    }
  
    return deviceType
  }

  static reverseLookupService(term){
    
    return [].concat( 
      RFParty.reverseLookupByName(DeviceIdentifiers.APPLE_Continuity, term),
      RFParty.reverseLookupByName(DeviceIdentifiers.UUID, term),
      RFParty.reverseLookupByName(DeviceIdentifiers.UUID16, term)
    )
  }

  static reverseLookupByName(map, text){
    let names = []
    for(let code in map){
      const name = map[code]

      if(name.indexOf(text) != -1 ){
        names.push(name)
      }
    }

    return names
  }
}