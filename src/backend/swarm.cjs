const HyperSwarm = require("hyperswarm");
const DHT = require('@hyperswarm/dht')
const progress = require("progress-stream");
const {createWriteStream, createReadStream} = require("fs");
const { sleep, trimExtra } = require('./utils.cjs');
const {saveGroupMsg} = require("./database.cjs")
const {
    ipcMain
} = require('electron')
const {verifySignature, decryptSwarmMessage, signMessage} = require("./crypto.cjs")
const { 
    expand_sdp_answer, 
    expand_sdp_offer, 
    parse_sdp } = require("./sdp.cjs")

let localFiles = []
let remoteFiles = []
let active_swarms = []
let active_voice_channel = {joined: false, topic: ""}
let downloadDirectory
let sender
let chat_keys
let my_address


async function send_voice_channel_sdp(data) {
    let active = active_swarms.find(a => a.topic === data.topic)
    let connection = active.connection.find(a => a.address === data.address)
    console.log("Send sdp data", data)
    if (!connection) return

    connection.write(JSON.stringify(data))
}

const send_voice_channel_status = async (joined = false, key) => {
    let active = active_swarms.find(a => a.key === key)
    let msg = joined ? "Joined voice" : "Left voice"
    let sig = await signMessage(msg, chat_keys.privateSpendKey)
    let data = JSON.stringify({
        address: my_address,
        signature: sig,
        message: msg,
        voice: joined,
        topic: active.topic
    })

    console.log("data", data)

    sendSwarmMessage(data, key)
    if (joined) { 

        set_voice_channel_status(data)
        if (!active.connections.some(a => a.voice === true)) return
        let active_voice = active.connections.filter(a => a.voice === true)
        active_voice.forEach(async function(user) {
            await sleep(300)
           join_voice_channel(key, active.topic, user.address)
        })


    } else {
        set_leave_voice_channel_status()
    }
    
    console.log("Sent joined voice mesg")
}

const join_voice_channel = (key, topic, address) => {
    sender("join-voice-channel", {key, topic, address})
}


const newSwarm = async (topic, key, ipc, xkr_keys, xkr_address, name) => {
    sender = ipc
    chat_keys = xkr_keys
    my_address = xkr_address
    return await createSwarm(topic, key, name)
}

const set_voice_channel_status = (data) => {
    active_voice_channel = data
}

const set_leave_voice_channel_status = () => {
    active_voice_channel = {joined: false, topic: ""}
}

const endSwarm = async (topic) => {
    let active = active_swarms.find(a => a.topic === topic)
    active.connections.forEach(chat => {
        chat.write(JSON.stringify({type: "disconnected"}))
    })
  
    sender('swarm-disconnected', topic)

    await active.swarm.leave(Buffer.from(topic))
    await active.discovery.destroy()
    await active.swarm.destroy()
    active_swarms.pop(active)
}

const createSwarm = async (hash, key, name) => {

    active_swarms.push({key, topic: hash, connections: [], call: []})

    let active = active_swarms.find(a => a.key === key)
    
    let discovery
    let swarm 
    //Derive new secret?
    let secret = Buffer.alloc(32).fill(key)
    let keyPair = DHT.keyPair(secret)

    try {
        swarm = new HyperSwarm({firewall (remotePublicKey, payload) {
            console.log("payload? key?", remotePublicKey)
            return !remotePublicKey.equals(keyPair.publicKey)
            }, keyPair})
    } catch (e) {
        console.log('Error starting swarm')
        return
    }      

    console.log("My public!", keyPair.publicKey)
    console.log("swarm key", swarm.keyPair.publicKey)
    active.swarm = swarm
    sender('swarm-connected', {topic: hash, key, channels: [], voice_channel: [], connections: []})
    console.log('active swarms', active_swarms)

    swarm.on('connection', (connection, information) => {

        console.log("*********Got new Connection! ************")
        active.connections.push(connection)
        sendJoinedMessage(key, name, hash)
        //checkIfOnline(hash)
        connection.on('data', async data => {

            incomingMessage(data, hash, connection, key)

        })

        connection.on('close', () => {
            connection_closed(connection, hash)
        })
    })

    swarm.on('update', (event) => {
        console.log("Event", event)
        //TODO Check for discconeected peeeers
    })
    

    process.once('SIGINT', function () {
        swarm.on('close', function () {
            process.exit();
        });
        swarm.destroy();
        setTimeout(() => process.exit(), 2000);
    });
    
    let topic = Buffer.alloc(32).fill(hash)
    discovery = swarm.join(topic, {server: true, client: true})
    active.discovery = discovery
    await discovery.flushed()
    console.log("Flushed")
}

const connection_closed = (conn, topic) => {
    console.log("Connection cloesd")
    let active = get_active(topic)
    if (!active) return
    let connection = active.connections.find(a => conn)
    sender("peer-disconnected", {address: connection.address, topic})
    active.connections.pop(connection)
}

const get_active = (topic) => {
    let active = active_swarms.find(a => a.topic === topic)
    if (!active) return false
    return active
}

const checkJoinMessage = async (data, connection, topic) => {

    try {
        data = JSON.parse(data)
    } catch (e) {
        return false
    }
    console.log("Got join message *********", data)

    if (typeof data === "object") {

        let active = get_active(topic)
        console.log("Got active", active)
        if (!active) return "Error"
        let con = active.connections.find(a => a === connection)
        const verified = await verifySignature(data.message, data.address, data.signature)
        if(!verified) return "Error"

        if ('joined' in data) { 
    
            console.log("Got joined msg ")
            if (con.joined) return true
            let addr = data.address
            con.joined = true
            con.address = addr
            sender("peer-connected", data)
            return true
        }

        if ('voice' in data) {

            console.log("Got voice joined", data)
            console.log("Got data voice joined status", data.voice)
            console.log("Check connection voice status", con.voice)
            if (data.voice === con.voice) return true
            if (data.address !== con.address) return "Error"
            con.voice = data.voice ? true : false
            sender("voice-channel-status", data)
        }

        if ('offer' in data) {
            console.log("Got voice offer / answer", data)
            if (!active_voice_channel.joined === true && active_voice_channel.topic === data.topic) return
            
            if (data.offer === true) {
                answer_call(data)
            } else {
                got_answer(data)
            }
            return true
        }

        if ('type' in data) {
            if (data.type === "disconnected") {
                connection_closed(connection, active.topic)
            }
        }
    }

    return false
}

const answer_call = (offer) => {
    sender('answer-voice-channel', offer)
}

const got_answer = (answer) => {
    sender('got-answer-voice-channel', answer)
}

const sendJoinedMessage = async (key, name, topic) => {
    let msg = "Joined"
    let sig = await signMessage(msg, chat_keys.privateSpendKey)
    let data = JSON.stringify({
        address: my_address,
        signature: sig,
        message: msg,
        joined: true,
        topic: topic,
        name: name
    })
    console.log("Sent joined mesg")
    sendSwarmMessage(data, key)
}

const incomingMessage = async (data, topic, connection, key) => {
          
    console.log("Got data incoming", data)
    const str = new TextDecoder().decode(data);
    if (str === "Ping") return
    //if (checkDataMessage(str, addr, connection)) return
    let check = await checkJoinMessage(data, connection, topic)
    if (check === "Error") {
        //Close connection.
    }
    if (check) return
    let hash = str.substring(0,64)
    console.log("Message incoming", str)
    let [message, time, hsh] = await decryptSwarmMessage(str, hash, key)
    console.log("Decrypted", message)
    if (!message) return
    console.log("Message", message)
    let msg = await saveGroupMsg(message, hsh, time)
        //Send new board message to frontend.
        sender('groupMsg', msg)
        sender('newGroupMessage', msg)

}


const sendSwarmMessage = (message, key) => {
    console.log("Sending swarm msg", message)
    let active = active_swarms.find(a => a.key === key)
    active.connections.forEach(chat => {
        chat.write(message)
    })

    console.log("Swarm msg sent!")
}

const checkIfOnline = (addr) => {
    let interval = setInterval(ping, 10 * 1000)
    function ping() {
        let active = active_swarms.find(a => a.topic === addr)
        if (!active) {
            clearInterval(interval)
            return
        } else {
            active.connections.forEach((a) => a.write('Ping'))
        }
    }
}


const errorMessage = (message) => {
    sender('error-notify-message', message)
}

ipcMain.on('join-voice', async (e, key) => {
    console.log("Join voice", key)
    send_voice_channel_status(true, key)
})

ipcMain.on('exit-voice', async (e, key) => {
    console.log("exit voice", key)
    send_voice_channel_status(false, key)
})

ipcMain.on('get-sdp-voice-channel', async (e, data) => {
   get_sdp(data)
})


ipcMain.on('expand-voice-channel-sdp', async (e, data, address) => {
   //expand
   let recovered_data = expand_sdp_offer(data, true)
   let expanded_data = [recovered_data, address]
   sender('got-expanded-voice-channel', expanded_data)
 })
 

function get_sdp(data) {

    let sendMessage

    if (data.type == 'offer') {
        let parsed_data = `${data.video ? 'Δ' : 'Λ'}` + parse_sdp(data.data, false)
        let recovered_data = expand_sdp_offer(parsed_data)
        //send
        sendMessage = {
            data: parsed_data,
            offer: true,
            address: data.address,
            topic: data.topic
        }

    } 

    else if (data.type == 'answer')  {
        let parsed_data = `${data.video ? 'δ' : 'λ'}` + parse_sdp(data.data, true)
        console.log('parsed data really cool sheet:', parsed_data)
        let recovered_data = expand_sdp_answer(parsed_data)
        //Send expanded recovered data to front end for debugging etc, this can be removed
        sender('rec-off', recovered_data)
        //send
         sendMessage = {
            data: parsed_data,
            offer: false,
            address: data.address,
            topic: data.topic
        }
    }

    send_voice_channel_sdp(sendMessage)
}


module.exports = {newSwarm, sendSwarmMessage, endSwarm}
