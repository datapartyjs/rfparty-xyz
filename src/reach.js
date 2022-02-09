module.exports = function(obj, path, defaultVal=null){
  var tokens = path.split('.')
  var val = obj;

  try{
    for(var i=0; i<tokens.length; i++){
      val = val[tokens[i]]
    }

    if(val == undefined){ val = defaultVal }
  }
  catch(excp){
    val = (defaultVal != undefined) ? defaultVal : null
  }

  return val;
}