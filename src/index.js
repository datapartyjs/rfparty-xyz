import {MainWindow} from './main-window'

import { RFParty } from './rfparty'

const JSONPath = require('jsonpath-plus').JSONPath


window.JSONPath = JSONPath
window.rfparty = null
window.RFParty = RFParty
window.MainWindow = MainWindow
