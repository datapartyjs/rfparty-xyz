
const xmljs = require('xml-js')

import { RFParty } from './rfparty'
import {LoadingProgress} from './loading-progress'



export class MainWindow {
  static onload(divId) {
    console.log('RFParty.onload')
    window.rfparty = new RFParty(divId)

    const form = document.getElementsByName('setupForm')[0]
    form.addEventListener('submit', MainWindow.startSession);

    const versionText = document.getElementById('version-text')
    versionText.innerText = 'v' + RFParty.Version


    MainWindow.openSetupForm()
  }

  static hideDiv(divId){ return MainWindow.addRemoveClass(divId, 'add', 'hidden') }

  static showDiv(divId){ return MainWindow.addRemoveClass(divId, 'remove', 'hidden') }


  static addRemoveClass(divId, addRemove='add', className='hidden', display='block'){
    var div = document.getElementById(divId)

    //console.log('div', addRemove, className, div)
    
    if(addRemove==='remove'){
      div.classList.remove(className)
      
      if(className=='hidden'){
        div.style.display = display
      }
      //console.log('remove')
    }
    else{
      //console.log('add')
      
      if(className=='hidden'){
        div.style.display = "none";
      }
      div.classList.add(className)
    }

  }

  static openSetupForm() {
    MainWindow.showDiv('setup-modal')
    MainWindow.showDiv('modal-shadow')
    MainWindow.showDiv('logo')
    MainWindow.showDiv('center-modal', 'remove', 'hidden', 'flex')

  }

  static closeSetupForm() {
    if (window.rfparty == null) {
      return
    }
    

    MainWindow.hideDiv('center-modal')
    MainWindow.hideDiv('logo')
    MainWindow.hideDiv('setup-modal')
    
  }

  static openLoading(){
    MainWindow.showDiv('modal-shadow')
    MainWindow.showDiv('center-modal', 'remove', 'hidden', 'flex')
    MainWindow.showDiv('logo')
    MainWindow.showDiv('loading-bar')

    MainWindow.addRemoveClass('logo', 'add', 'rainbow-busy')

    window.loadingState = new LoadingProgress()

    window.loadingState.on('step-start', (name)=>{
      document.getElementById('loading-details').value = window.loadingState.toString()
    })

    window.loadingState.on('step-complete', (name)=>{
      document.getElementById('loading-details').value = window.loadingState.toString()
    })

    window.loadingState.on('progress', (progress)=>{
      document.getElementById('loading-value').innerText=''+ Math.round(progress*100)
      document.getElementById('loading-progress-bar').value= progress*100
    })
  }

  static closeLoading(){

    MainWindow.addRemoveClass('center-modal', 'add', 'fadeOut')

    setTimeout(()=>{      
      MainWindow.hideDiv('center-modal')
      MainWindow.hideDiv('logo')
      MainWindow.hideDiv('modal-shadow')
      MainWindow.hideDiv('loading-bar')
      MainWindow.addRemoveClass('logo', 'remove', 'rainbow-busy')
    }, 2000)

  }

  static async startSession(event) {
    event.preventDefault()
    console.log('startSession')


    MainWindow.closeSetupForm()
    MainWindow.openLoading()


    await MainWindow.setupSession()

    /*let setupPromise = new Promise((resolve,reject)=>{
      setTimeout(()=>{
        try{
          //resolve()
          resolve(MainWindow.setupSession())
        }
        catch(err){
          reject(err)
        }

        MainWindow.hideDiv('logo')
        MainWindow.closeLoading()

      }, 1500)
    })*/

    //await setupPromise
    MainWindow.closeLoading()
  }

  static async delay(ms=100){
    return new Promise((resolve, reject)=>{
      setTimeout(resolve, ms)
    })
  }

  static async setupSession(){

    const gpxFiles = document.getElementById('gpxFiles')

    //console.log('selected ', gpxFiles.files.length, 'gpx files')

    const fileLoaders = []

    const scanDbFile = document.getElementById('scanDBFile')

    const scanDbReader = new FileReader()
    let dbLoad = new Promise((resolve, reject) => {
      window.loadingState.startStep('read '+scanDbFile.files[0].name)
      scanDbReader.onload = ()=>{

        window.loadingState.completeStep('read '+scanDbFile.files[0].name)

        //console.log('finished reading scan db')
        resolve(window.rfparty.addScanDb(scanDbReader.result, scanDbFile.files[0].name))
      }
      scanDbReader.onabort = reject
      scanDbReader.addEventListener('error', reject)
    })

    //console.log('scanDB', scanDbFile.files[0])
    scanDbReader.readAsText(scanDbFile.files[0])
    fileLoaders.push(dbLoad)

    //await dbLoad

    for (let file of gpxFiles.files) {
      const reader = new FileReader()
      window.loadingState.startStep('read '+file.name)

      let fileLoad = new Promise((resolve, reject) => {
        reader.onload = () => {
          
          const json = xmljs.xml2js(reader.result, {
            compact: true,
            textKey: 'value',
            nativeType: true,
            nativeTypeAttributes: true
          })
          window.loadingState.completeStep('read '+file.name)

          
          
          resolve(window.rfparty.addGpx(json, file.name))

          
        }
        reader.onabort = reject
        reader.addEventListener('error', reject)
      })

      reader.readAsText(file)

      fileLoaders.push(fileLoad)
    }


    const fileContent = await Promise.all(fileLoaders)

    MainWindow.delay(1000)

    await window.rfparty.start()

    let searchElem = document.getElementById('search-input')

    searchElem.addEventListener('change', (event)=>{

      const input = event.target.value

      console.log('search input', input)
      window.rfparty.handleSearch.bind(window.rfparty)(input)


    })
  }
}