const moment = require('moment')
const EventEmitter = require('last-eventemitter')



export class LoadingProgress extends EventEmitter {
  constructor(){
    super()
    this.steps = {}
  }

  get stepCount(){
    return Object.keys(this.steps).length
    /*
    let count = 0

    for(let name in this.steps){
      const step = this.steps[name]
      count+=step.parts
    }

    return count*/
  }

  get completedCount(){
    let count = 0

    for(let name in this.steps){
      const step = this.steps[name]
      if(step.parts > 1){
        count+= (step.completedParts / step.parts)
      } else if(step.successOrFail !== null){
        count++
      }
    }

    return count
  }

  get progress(){
    let count = this.stepCount
    
    if(count > 0){
      return this.completedCount / this.stepCount
    }

    return 0.0
  }

  hasStep(name){ return this.steps[name]!==undefined }

  startStep(name, parts=1){

    if(this.hasStep(name)){
      throw new Error('duplicate step name: '+name)
    }

    this.steps[name] = {
      name,
      parts,
      completedParts: 0,
      started: Date.now(),
      message: null,
      finished: null,
      successOrFail: null
    }

    this.emit('step-start', name)

    this.emit('progress', this.progress)
  }

  getStepProgress(name){
    const step = this.steps[name]
    return (step.completedParts / step.parts)
  }

  completePart(name){
    this.steps[name].completedParts++
  }

  completeStep(name, successOrFail=true, message){
    this.steps[name].finished = Date.now()
    this.steps[name].successOrFail = successOrFail
    this.steps[name].message = message

    this.emit('progress', this.progress)

    this.emit('step-complete', name, successOrFail)

    if(this.progress >= 1.0){
      this.emit('finished', this)
    }

    if(successOrFail === false){
      this.emit('error', {step: name, message})
    }
  }

  toString(){
    //return JSON.stringify( this.steps, null, 2 )

    let runningOutput = ''
    let finishedOutput = ''

    for(let name in this.steps){
      const step = this.steps[ name ]

      if(step.finished == null){
        //runningOutput += '\t'+name+'\t\t'+ Math.round( this.getStepProgress(name) * 100 ) + '%\n'
        runningOutput += `\t◌\t ${step.name} \t\t\t ${Math.round( this.getStepProgress(name) * 100 )}%\n`
      }
      else{
        let deltaMs = Math.abs( moment(step.started).diff(step.finished) )
        runningOutput += `\t✓\t ${step.name} (${deltaMs}ms) \t\t\t🤘🏿 \n`
      }
    }

    return finishedOutput + '\n' + runningOutput
  }
}
