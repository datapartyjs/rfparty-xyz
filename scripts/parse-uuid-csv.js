const fs = require('fs')
const csv = require('csv/sync')


const content = fs.readFileSync('./specs/16-bit UUID Numbers Document-cleaned.csv')


const jsCsv = csv.parse(content.toString())

console.log(jsCsv[0])


let categories = {}

for(let i=1; i<jsCsv.length; i++){
  const arr = jsCsv[i]
  let obj = {
    category: arr[0].replace(/ /g, '').replace('16-bitUUIDforMembers', "Company"),
    uuid: arr[1].toLowerCase().replace('0x',''),
    name: arr[2]
  }

  //list.push(obj)
  if( !categories[obj.category] ){ categories[obj.category] = {}  }

  categories[obj.category][obj.uuid] = obj.name
}

console.log(JSON.stringify( categories, null, 2))