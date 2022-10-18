//import { point } from 'leaflet'
//import { scan } from 'node-wifi'

import { last } from 'lodash'

//const Debug = require('debug')('rfparty')
const Leaflet = require('leaflet')
const JSON5 = require('json5')
const Pkg = require('../package.json')
const JSONPath = require('jsonpath-plus').JSONPath
const reach = require('./reach')
const Loki = require('lokijs')
const moment = require('moment')
const EventEmitter = require('last-eventemitter')

import * as UUID16_TABLES from './16bit-uuid-tables'
import * as MANUFACTURER_TABLE from './manufacturer-company-id.json' 
const DeviceIdentifiers = require('./device-identifiers')

const JSONViewer = require('json-viewer-js')

const TILE_SERVER_DEFAULT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_SERVER_DARK = 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png'
const TILE_SERVER_LIGHT = 'https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png'

const TILE_SERVER_MAPBOX = 'https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}'
const TILE_SERVER_MAPBOX_CONFIG = {
  //attribution: '<span id="map-attribution" class="map-attribution">Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Imagery © <a href="https://www.mapbox.com/">Mapbox</a></span>',
    maxZoom: 20,
    id: 'mapbox/dark-v10',
    tileSize: 512,
    zoomOffset: -1,
    accessToken: 'pk.eyJ1IjoiZGF0YXBhcnR5IiwiYSI6ImNremFnMnlyZjIzZHMycG5mczZ1bDljM2gifQ.uGoEE_YpTbIlELvytTzbNQ'
}

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


export class RFParty extends EventEmitter {
  constructor(divId) {
    super()

    this.showAllTracks = true
    this.showAwayTracks = false

    this.detailsViewer = null

    this.map = Leaflet.map(divId,{
      attributionControl: false
    }).setView([47.6, -122.35], 13)

    Leaflet.tileLayer(TILE_SERVER_MAPBOX, TILE_SERVER_MAPBOX_CONFIG).addTo(this.map);
    //Leaflet.control.attribution({prefix: '<span id="map-attribution" class="map-attribution">Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Imagery © <a href="https://www.mapbox.com/">Mapbox</a></span>' })
    //  .addTo(this.map)


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
        'lastlocation.lat', 'lastlocation.lon',
        'firstlocation.lat', 'firstlocation.lon',
        'connectable', 'addressType', 'services', 'hasUnknownService', 'ibeacon.uuid', 'findmy.maintained',
        'company', 'product', 'companyCode', 'productCode', 'appleContinuityTypeCode', 'appleIp']
    })

    this.db.addCollection('appleDevices', {
      indices: ['address', 'continuityCode', 'ip']
    })

    this.mobileSegments = []

    this.srcs = {}

    this.deviceLayers = {}
    this.searchResults = null
    this.lastRender = null
    this.lastQuery = null

    this.scanDb = null
    this.gpx = {}
    this.gpxLines = {}
    this.gpxLayer = Leaflet.layerGroup()
    

  }

  async start() {
    console.log('starting')
    
    if(this.showAllTracks){
    
      for(let name in this.gpxLines){ 
        this.gpxLayer.addLayer(this.gpxLines[name])
      }
    
    	this.gpxLayer.addTo(this.map)
    }

    this.emit('search-start')
    let searchStartTime = new moment()

    let awayTime = this.db.getCollection('awayTime').find()

    console.log('found', awayTime.length, 'away time periods')

    this.lastQuery = {duration: {
      $gt: 30*60000
    }}


    for (let away of awayTime) {
      let track = this.getTrackByTime(away.starttime, away.endtime)

      if(track.length == 0){continue}

      let latlngs = this.trackToLatLonArray(track)

      console.log('\trendering', latlngs.length, 'track points')

      if(this.showAwayTracks){
        Leaflet.polyline(latlngs, { color: 'yellow', opacity: 0.74, weight: '2' }).addTo(this.map)
      }

    }

    await this.handleSearch('duration')

    this.map.on('moveend', ()=>{

      if(!this.lastRender){ return }
      if(!this.lastQuery){ return }

      if(this.lastRender.drawable != this.lastRender.onscreen){
        this.doQuery(this.lastQuery)
      }
    })

    /*let searchEndTime = new moment()
    let searchDuration = searchEndTime.diff(searchStartTime)
    
    this.emit('search-finished', {devices, searchDuration})


    let renderStartTime = new moment()
    this.emit('render-start')
    
    await this.renderBleDeviceList(devices)

    let renderEndTime = new moment()
    let renderDuration = renderEndTime.diff(renderStartTime)


    this.emit('render-finished', {devices, renderDuration})

    let updateEndTime = new moment()
    let updateDuration = updateEndTime.diff(searchStartTime)
    this.emit('update-finished', {devices, updateDuration, searchDuration, renderDuration})*/

  }

  async handleSearch(input){
    let query = null
    let updateStartTime = new moment()

    if(input[0]=='{'){
      console.log('raw query')
      const obj = JSON5.parse(input)

      console.log('parsed query', obj)
      query = obj
    }else{
      const tokens = input.split(' ')

      let term = tokens.slice(1).join(' ')
      switch(tokens[0]){
        case 'mac':
        case 'address':
          query = { 'address':  {'$contains':  term } }
          break
        case 'here':
          let viewport = this.map.getBounds()
          query = { $or: [
            { $and: [
              {firstlocation: {$exists: true}},
              {'lastlocation': {$ne: null}},
              {'firstlocation': {$ne: null}},
              {'firstlocation.lat': {$exists: true}},
              {'firstlocation.lon': {$exists: true}},
              {'firstlocation.lat': { $lt: viewport.getNorth() }},
              {'firstlocation.lat': { $gt: viewport.getSouth() }},
              {'firstlocation.lon': { $lt: viewport.getEast() }},
              {'firstlocation.lon': { $gt: viewport.getWest() }},
            ]},
            { $and: [
              {lastlocation: {$exists: true}},
              {'lastlocation': {$ne: null}},
              {'firstlocation': {$ne: null}},
              {'lastlocation.lat': {$exists: true}},
              {'lastlocation.lon': {$exists: true}},
              {'lastlocation.lat': { $lt: viewport.getNorth() }},
              {'lastlocation.lat': { $gt: viewport.getSouth() }},
              {'lastlocation.lon': { $lt: viewport.getEast() }},
              {'lastlocation.lon': { $gt: viewport.getWest() }},
            ]}
          ]}
          break
        case 'nolocation':
          query = {'$or': [
            {'firstlocation': {'$exists': false}},
            {'lastlocation': {'$exists': false}},
            {'firstlocation': null },
            {'lastlocation': null },
          ]}
          break
        case 'name':
        case 'localname':
          console.log('select by name', tokens)
          query = {
            'advertisement.localName':  {'$contains':  term }
          }
  
          console.log('term['+term+']')
  
          break
        case 'company':
          console.log('select by company', tokens)
          query = {
            'company':  {'$contains':  term }
          }
          break
  
        case 'product':
          console.log('select by product', tokens)
          
          query = {
            'product':  {'$contains':  term }
          }
          break
  
        case 'unknown':
        case 'unknown-service':
          query = {
            'hasUnknownService':  {'$exists': true }
          }
          break
        case 'service':
          const serviceTerm = tokens[1]
          console.log('select by service', serviceTerm)
          let possibleServices = RFParty.reverseLookupService(serviceTerm)
          console.log('possible', possibleServices)
          query = {
            'services':  {'$containsAny':  possibleServices },
            ...this.parseServiceSearch(serviceTerm.toLowerCase(), tokens.slice(2))
          }
          break
  
        case 'appleip':
        case 'appleIp':
          console.log('select by appleIp', tokens)
          if(tokens.length < 2){
            query = {
              'appleIp':  {'$exists': true }
            }
          }
          else{
            query = {
              'appleIp':  {'$contains':  term }
            }
          }
          break
  
        case 'random':
          query = {
            'addressType':  {'$eq':  'random' }
          }
          break
        case 'public':
          query = {
            'addressType':  {'$eq':  'public' }
          }
          break
        case 'connectable':
          query = {
            'connectable':  {'$eq':  true }
          }
          break
        case 'duration':
          if(tokens.length < 2){
            query = {
              duration: {
                $gt: 30*60000
              }
            }

          } else {

            query = {
              duration: {
                $gt: moment.duration("PT" + term.toUpperCase()).as('ms') || 30*60000
              }
            }

          }
          break

        case 'error':
          query = {'protocolError': {'$exists': true}}
          break
  
        default:
          console.log('invalid search type', tokens[0])
          this.emit('search-failed')
          return
      }
    }

    if(!query){ 
      let updateEndTime = new moment()
      let updateDuration = updateEndTime.diff(updateStartTime)
      this.emit('update-finished', {query: this.lastQuery, updateDuration, render: this.lastRender})

      return
    }

    await this.doQuery(query, updateStartTime)
  }

  async doQuery(query, updateStartTime=new moment()){
    console.log('running query...', query)

    this.emit('search-start', {query})

    let searchStartTime = new moment()

    const devices = this.db.getCollection('ble').chain().find(query).data()
    
    let searchEndTime = new moment()
    let searchDuration = searchEndTime.diff(searchStartTime)
    
    this.emit('search-finished', {query, render: {count: devices.length}, searchDuration})


    let durations = {searchDuration}

    //console.log('rendering devices...', devices)
    if(devices != null){

      this.emit('render-start')
      let renderStartTime = new moment()

      await delay(30)
      
      await this.renderBleDeviceList(devices)
      
      let renderEndTime = new moment()
      let renderDuration = renderEndTime.diff(renderStartTime)

      durations.renderDuration = renderDuration


      this.emit('render-finished', {query, render: this.lastRender, renderDuration})
    }

    let updateEndTime = new moment()
    let updateDuration = updateEndTime.diff(updateStartTime)
    this.emit('update-finished', {query, render: this.lastRender, updateDuration, ...durations})

    this.lastQuery = query
  }


  parseServiceSearch(service, terms){
    let query = {}
    
    if(terms.length==0){ return }

    switch(service){
      case 'ibeacon':
        query = { 'ibeacon.uuid': { $contains: terms[0] } }
        break
      case 'findmy':
        query = { 'findmy.maintained': { $eq: terms[0] == 'found'}}
        break
      default:
        break
    }

    return query
  }

  async renderBleDeviceList(bleDevices){
    this.lastRender = {
      count: bleDevices.length,
      onscreen: 0,
      drawable: 0
    }

    console.log('\trendering', bleDevices.length, 'ble devices')

    let restrictToBounds = this.restrictToBounds || bleDevices.length > 3000


    let layer = Leaflet.layerGroup()

    let count = 0
    for (let dev of bleDevices) {

      //if(dev.duration < 30*60000){ continue }

      count++
      if((count % 500) == 0){ await delay(1) }

      let lastPt = dev.lastlocation
      let firstPt = dev.firstlocation

      if(!lastPt || !firstPt){ continue }

      let corner1 = new Leaflet.LatLng(lastPt.lat, lastPt.lon)
      let corner2 = new Leaflet.LatLng(firstPt.lat, firstPt.lon)

      let bounds = new Leaflet.LatLngBounds(corner1, corner2)

      this.lastRender.drawable++
      if(restrictToBounds == true && !this.map.getBounds().intersects(bounds)) { continue }

      this.lastRender.onscreen++
      

      if (lastPt) {
        let lastCircle = Leaflet.circle([lastPt.lat, lastPt.lon], { color: 'white', radius: 10, fill:true, weight:1, opacity: 1, fillOpacity:0.3, fillColor:'white' })
        layer.addLayer(lastCircle)

        let onclick = (event)=>{
          this.handleClick({
            event,
            type: 'ble', 
            id: dev.$loki,
            value: dev.address,
            timestamp: dev.lastseen
          })
        }

        lastCircle.on('click', onclick)



        if(firstPt){
          let line = Leaflet.polyline([
            this.trackToLatLonArray([firstPt, lastPt])
          ], { color: 'blue', opacity: 0.5, weight: '5' })

          layer.addLayer(line)
          line.on('click', onclick)
          

          let firstCircle = Leaflet.circle([firstPt.lat, firstPt.lon], { color: 'yellow', radius: 5, fill:true, weight:1, opacity: 1 })

          layer.addLayer(firstCircle)
          firstCircle.on('click', (event)=>{
            this.handleClick({
              event,
              type: 'ble', 
              id: dev.$loki,
              value: dev.address,
              timestamp: dev.firstseen
            })
          })
        }
      }
    }

    

    
    layer.addTo(this.map)

    if(this.searchResults != null){
      this.map.removeLayer(this.searchResults)
      delete this.searchResults
    }

    this.searchResults = layer

    return
  }

  getBLEDevice(mac){
    return this.db.getCollection('ble').find({address:mac})[0]
  }

  updateDeviceInfoHud(){
    let devices = Object.keys( this.deviceLayers )
    if(devices.length == 0){
      window.MainWindow.hideDiv('device-info')
      /*let deviceInfo = document.getElementById('device-info')
      deviceInfo.classList.add('hidden')*/
    } else {
      
      

      let device = this.getBLEDevice(devices[0])

      console.log('updateDeviceInfoHud', device)


      //document.getElementById('device-info-mac').textContent = reach(device, 'address')
      //document.getElementById('device-info-name').textContent = reach(device, 'advertisement.localName')


      let companyText = ''

      if(reach(device, 'company')){
        if(!reach(device,'companyCode')){
          companyText=reach(device, 'company') 
        } else {
          companyText=reach(device, 'company') + '(' + reach(device, 'companyCode') + ')'
        }
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

      document.getElementById('device-info-duration').textContent = moment.duration(device.duration).humanize()

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



      let details = document.getElementById('device-info-detailscontainer')

      while (details.firstChild) { details.removeChild(details.firstChild) }

      this.detailsViewer = new JSONViewer({
        container: details,
        data: JSON.stringify(device),
        theme: 'dark',
        expand: false
      })
      //

      //! @todo

      window.MainWindow.showDiv('device-info')
      
    }
  }


  handleClick({id, type, value, timestamp, event}){
    console.log('clicked type=', type, value, timestamp, event)

    if(type == 'ble'){

      console.log('shift', event.originalEvent.shiftKey)

      //this.selectedLayers = [ value ]

      let layer = Leaflet.layerGroup()

      //let device = this.getBLEDevice(value)
      let device = this.db.getCollection('ble').findOne({'$loki':id})

      let devicePathLL = []

      

      for(let observation of device.seen){
        let pt = this.getTrackPointByTime(observation.timestamp)



        if(pt){ 
          devicePathLL.push([ pt.lat, pt.lon ])
          let circle = Leaflet.circle([pt.lat, pt.lon], { color: 'green', radius: 8, fill:true, weight:1, opacity: 0.9 })

          circle.on('click', (event)=>{
            this.handleClick({
              event,
              type: 'ble', 
              id: device.$loki,
              value: device.address,
              timestamp: observation.timestamp
            })
          })

          layer.addLayer(circle)
        }
      }

      if(devicePathLL.length > 0){
        let line = Leaflet.polyline(devicePathLL, { color: 'green', opacity: 0.9, weight: '4' })

        line.on('click', (event)=>{
          this.handleClick({
            event,
            type: 'ble', 
            id: device.$loki,
            value: device.address,
            timestamp: device.lastseen
          })
        })
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
    let track = this.getTrackByTime(timestamp - 1200000, timestamp + 6000)

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

  checkTimeBoundIsBefore(a,b){
    return a.lastseen < b.firstseen
  }

  checkTimeBoundIsAfter(a,b){
    return a.firstseen > b.lastseen
  }

  checkTimeBoundOverlap(a,b){
    return (
      (a.firstseen >= b.firstseen && a.firstseen <= b.lastseen) ||    // start overlap
      (a.lastseen >= b.firstseen && a.firstseen <= b.lastseen)  ||    // last overlap
      (a.firstseen >= b.firstseen && a.lastseen <= b.lastseen ) ||    // a inside b
      (b.firstseen >= a.firstseen && b.lastseen <= a.lastseen )       // b inside a
    )
  }

  insertObservations(a, b){
    let idx=0;

    for(let seen of b.seen){
      for(idx; idx<a.seen.length; idx++){
        let current = a.seen[idx]
        if(current.timestamp<seen.timestamp){ break; }
        if(current.timestamp > seen.timestamp){ break; }
      }
  
      if(idx < a.seen.length) {
    
        a.seen.splice( idx, 0, seen )
      
      } else {
      
        a.seen.push[seen]
      
      }
    }

    if(b.firstseen < a.firstseen){
      a.firstseen = b.firstseen
      a.firstlocation = b.firstlocation
    
    }

    if(b.lastseen > a.lastseen){
      a.lastseen = b.lastseen
      a.lastlocation = b.lastlocation
    }
    
    return a
  }

  mergeObservations(a, b){
    let result = null
    if(this.checkTimeBoundIsBefore(a,b)) {

      a.seen = [].concat( a.seen, b.seen )
      result = a
      result.lastseen = b.lastseen
      result.lastlocation = b.lastlocation

    } else if(this.checkTimeBoundIsAfter(a,b)) {

      a.seen = [].concat( b.seen, a.seen )
      result = a
      result.firstseen = b.firstseen
      result.firstlocation = b.firstlocation

    } else if(this.checkTimeBoundOverlap(a,b)) {
      result = this.insertObservations(a,b)
    }

    result.duration = Math.abs( moment(result.firstseen).diff(result.lastseen) )

    return result
  }

  mergeBLEDevice(device){
    let bleColl = this.db.getCollection('ble')
    let dbDevice = this.getBLEDevice(device.address)


    if(!dbDevice) {

      bleColl.insert(device)

    } else {
      
      dbDevice = this.mergeObservations(dbDevice, device)
      bleColl.update(dbDevice)

    }

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
      if(count%1000 == 0){
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
      if(count%300 == 0){
        await delay(10)
      }


      let firstlocation = this.getTrackPointByTime(start)
      if(firstlocation){ firstlocation = {lat: firstlocation.lat, lon: firstlocation.lon} }
      
      let lastlocation = this.getTrackPointByTime(end)
      if(lastlocation){ lastlocation = {lat: lastlocation.lat, lon: lastlocation.lon} }

      let duration = Math.abs( moment(start).diff(end) )
      let doc = {
        firstseen: start,
        lastseen: end,
        firstlocation: firstlocation,
        lastlocation,
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
          doc.services.push(found)
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

        
    
        const manufacturerData = Buffer.from(device.advertisement.manufacturerData)
        const companyCode = manufacturerData.slice(0, 2).toString('hex').match(/.{2}/g).reverse().join('')

        doc.companyCode = companyCode
        doc.company = RFParty.lookupDeviceCompany(companyCode)
    
        // Parse Apple Continuity Messages 
        if(companyCode == '004c'){

          const subType = manufacturerData.slice(2, 3).toString('hex')
          const subTypeLen = manufacturerData[3]
          doc.appleContinuityTypeCode = subType

          if( subTypeLen + 4 >  manufacturerData.length){
            //console.error(device + originalJSON)
            doc.protocolError = {
              appleContinuity: 'incorrect message length[' + subTypeLen +'] when ' + (manufacturerData.length-4) + ' (or less) was expected'
            }

            console.warn(doc.address + ' - ' + doc.protocolError.appleContinuity)
            //throw new Error('corrupt continuity message???')
          }

          let appleService = RFParty.lookupAppleService(subType)
          if(appleService){
            doc.services.push( appleService )
          }
    
          if(subType =='09'){
            // Parse AirPlayTarget messages
    
            const devIP = manufacturerData.slice( manufacturerData.length-4, manufacturerData.length )
    
            const appleIp = devIP[0] + '.'
              + devIP[1] + '.'
              + devIP[2] + '.'
              + devIP[3]
    
              doc.appleIp = appleIp
          }
          else if(subType == '02'){
            // Parse iBeacon messages

            if(subTypeLen != 21){
              doc.protocolError = {
                ibeacon: 'incorrect message length[' + subTypeLen +'] when 21 bytes was expected'
              }
              console.warn(doc.address + ' - ' + doc.protocolError.ibeacon)
            }
            else{
              doc.ibeacon = {
                uuid: manufacturerData.slice(4, 19).toString('hex'),
                major: manufacturerData.slice(20, 21).toString('hex'),
                minor: manufacturerData.slice(22, 23).toString('hex'),
                txPower: (manufacturerData.length > 24) ? manufacturerData.readInt8(24) : undefined
              }
            }
          }
          else if(subType == '12'){
            // Parse FindMy messages

            const status = manufacturerData[4]
            const maintained =  (0x1 & (status >> 2)) == 1 ? true : false

            doc.findmy = { maintained }
          }
          else if(subType == '10'){
            // Parse NearbyInfo messages
            const flags = manufacturerData[4] >> 4
            const actionCode = manufacturerData[4] & 0x0f
            const status = manufacturerData[5]
            doc.nearbyinfo = {
              flags: {
                unknownFlag1: Boolean((flags & 0x2) > 0),
                unknownFlag2: Boolean((flags & 0x8) > 0),
                primaryDevice: Boolean((flags & 0x1) > 0),
                airdropRxEnabled: Boolean((flags & 0x4) > 0),
                airpodsConnectedScreenOn: Boolean((status & 0x1) > 0),
                authTag4Bytes: Boolean((status & 0x02) > 0),
                wifiOn: Boolean((status & 0x4) > 0),
                hasAuthTag: Boolean((status & 0x10) > 0),
                watchLocked: Boolean((status & 0x20) > 0),
                watchAutoLock: Boolean((status & 0x40) > 0),
                autoLock: Boolean((status & 0x80) > 0)
              },
              actionCode,
              action: DeviceIdentifiers.NearbyInfoActionCode[actionCode]
            }
          } else if (subType == '0f'){
            // Parse NearbyAction messages
            const flags = manufacturerData[4]
            const action = manufacturerData[5]
            doc.nearbyaction = { type: DeviceIdentifiers.NearbyActionType[action] }
          }
    
    
        }
      }

      this.mergeBLEDevice(doc)
      //bleColl.insert(doc)
    }

    for (let device of scanDbWifi.chain().find().data({ removeMeta: true })){
      window.loadingState.completePart('index '+name)

      count++
      if(count%3000 == 0){
        await delay(1)
      }
    }
    
    
    
    console.log('importing wifi . . .')
    window.loadingState.completeStep('index '+name)
    
    await delay(200)
    

    //! @todo support a flag for whether sources should be kept after importing

    //this.scanDb = scanDb
  }

  async addGpx(obj, name) {
    console.log('adding gpx', name)

    let collection = this.db.getCollection('locationTrack')

    //this.gpx[name]=obj

    const trackPoints = JSONPath({ json: obj, path: '$..trkpt', flatten: true })
    
    if(!trackPoints){
       window.loadingState.startStep('index '+name, 1)
       window.loadingState.completeStep('index '+name)
       console.log('added gpx', name, 'with', undefined, 'points')
       return
    }
    
    window.loadingState.startStep('index '+name, trackPoints.length)

    let latlngs = []

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
      this.gpxLines[name] = Leaflet.polyline(latlngs, { color: 'red', opacity: 0.4, weight: '2' })
      
      //this.gpxLines[name].addLayer(this.gpxLayer)
      //this.gpxLayer.addLayer(this.gpxLines[name])
    }

    
    window.loadingState.completeStep('index '+name)
    console.log('added gpx', name, 'with', trackPoints.length, 'points')
    //console.log('latlong', latlngs)
    //console.log('tracks', trackPoints)
  }

  static get Version() {
    return Pkg.version
  }

  


  static lookupDeviceCompany(code){
    return  MANUFACTURER_TABLE.Company[code] 
  }
  

  static lookupAppleService(code){
    return DeviceIdentifiers.APPLE_Continuity[code]
  }

  static lookupUuid16(uuid){
    const types = Object.keys(UUID16_TABLES)

    for(let type of types){
      let found = UUID16_TABLES[type][uuid]

      if(found){
        return '/'+type+'/'+found
      }
    }
  }
  
  static lookupDeviceUuid(uuid){
    let deviceType = null
  
    if(uuid.length == 4){
      //deviceType = DeviceIdentifiers.UUID16[uuid]
      deviceType = RFParty.lookupUuid16(uuid)
    }
    else if(uuid.length == 32){
      deviceType = DeviceIdentifiers.UUID[uuid] 
    }
  
    return deviceType
  }

  static reverseLookupService(term){

    let possibles = []

    const types = Object.keys(UUID16_TABLES)

    for(let type of types){ 
      possibles.push( 
        ...(RFParty.reverseLookupByName(
            UUID16_TABLES[type], term, '/'+type+'/'
        ).map( name=>{return '/'+type+'/'+name }) )
      )
    }
    
    return possibles.concat( 
      RFParty.reverseLookupByName(DeviceIdentifiers.APPLE_Continuity, term),
      RFParty.reverseLookupByName(DeviceIdentifiers.UUID, term)
    )
  }

  static reverseLookupByName(map, text, prefix=''){
    let names = []
    const lowerText = text.toLowerCase()
    for(let code in map){
      const name = map[code]
      const prefixedName = prefix+name
      const lowerName = prefixedName.toLowerCase()

      if(lowerName.indexOf(lowerText) != -1 ){
        names.push(name)
      }
    }

    return names
  }
}
