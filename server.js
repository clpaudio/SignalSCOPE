const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const snmp = require('net-snmp');
const xml2js = require('xml2js');
const { app: electronApp } = require('electron'); // Importamos electron para verificar si está empaquetado

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ruta base compatible tanto para desarrollo como para la app de escritorio empaquetada (.app)
const isPackaged = electronApp ? electronApp.isPackaged : false;
const basePath = isPackaged ? process.resourcesPath : __dirname;

app.use(express.static(path.join(basePath, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(basePath, 'public', 'index.html'));
});

let activeSwitchModel = "Netgear S350 Series (GS310TP)";
let currentClockMasterIp = "192.168.1.55"; 

const SWITCH_IP = "192.168.1.250";
const SNMP_COMMUNITY = "clp_dante";

let realHardwarePortsState = {}; 
let previousHardwarePortsState = {}; 
let realHardwareVlans = {}; 

let activeRegistry = {
  "192.168.1.58": { name: "AVIO1-CLP2IN", type: "AVIO-DAI2 (Analog Input)", ip: "192.168.1.58", port: 6, sensitivity: "+24 dBu", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.52": { name: "AVIO2-CLP2OUT", type: "AVIO-DAI2 (Analog Output)", ip: "192.168.1.52", port: 2, sensitivity: "+24 dBu", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.56": { name: "AVIO3-CLP2OUT", type: "AVIO-DAI2 (Analog Output)", ip: "192.168.1.56", port: 1, sensitivity: "+24 dBu", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.53": { name: "AVIO4-CLP-AES-EBU", type: "AVIO-AES3", ip: "192.168.1.53", port: 3, sensitivity: "Digital AES", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.54": { name: "AVIO5-CLP1IN", type: "AVIO-DAO1", ip: "192.168.1.54", port: 4, sensitivity: "+4 dBu", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.55": { name: "AVIO6-CLPUSB", type: "AVIO-USB", ip: "192.168.1.55", port: 5, sensitivity: "USB Audio", latencyConfig: "1.0 ms", linked: true },
  "192.168.1.50": { name: "MacBook-Pro", type: "Virtual Interface", ip: "192.168.1.50", port: 8, sensitivity: "CoreAudio", latencyConfig: "1.0 ms", linked: true }
};

const vlanStyles = {
  "V10 (Audio Pri)": { bg: "rgba(16, 185, 129, 0.2)", color: "#10b981" },
  "V20 (Audio Sec)": { bg: "rgba(59, 130, 246, 0.2)", color: "#3b82f6" },
  "V30 (Control)": { bg: "rgba(245, 158, 11, 0.2)", color: "#f59e0b" },
  "N/A": { bg: "#131822", color: "#94a3b8" }
};

function getVlanLabelFromId(vlanId) {
  switch (parseInt(vlanId)) {
    case 10: return "V10 (Audio Pri)";
    case 20: return "V20 (Audio Sec)";
    case 30: return "V30 (Control)";
    default: return `VLAN ${vlanId}`;
  }
}

function pollSwitchHardware() {
  try {
    const session = snmp.createSession(SWITCH_IP, SNMP_COMMUNITY, {
      port: 161,
      version: snmp.Version2c,
      timeout: 2500,
      retries: 1
    });

    const oids = [];
    for (let i = 1; i <= 8; i++) {
      oids.push(`1.3.6.1.2.1.2.2.1.8.${i}`);
    }
    for (let i = 1; i <= 8; i++) {
      oids.push(`1.3.6.1.2.1.17.7.1.4.5.1.1.${i}`);
    }

    session.get(oids, (error, varbinds) => {
      session.close();

      if (error) {
        console.error("[SNMP Error]:", error.toString());
      } else {
        for (let i = 0; i < 8; i++) {
          const portNum = i + 1;
          
          const vbStatus = varbinds[i];
          if (vbStatus && vbStatus.type !== snmp.ObjectType.NoSuchObject) {
            const statusVal = vbStatus.value; 
            const newStatus = (statusVal === 1) ? "Up" : "Down";

            if (previousHardwarePortsState[portNum] && previousHardwarePortsState[portNum] !== newStatus) {
              const alertMsg = `Puerto ${portNum} ${newStatus === 'Up' ? 'CONECTADO (Link UP)' : 'DESCONECTADO (Cable caído)'}`;
              console.log(`[ALERTA FÍSICA] ⚠️ ${alertMsg}`);

              io.emit('portAlert', {
                port: portNum,
                status: newStatus,
                message: alertMsg
              });
            }

            realHardwarePortsState[portNum] = newStatus;
            previousHardwarePortsState[portNum] = newStatus;
          }

          const vbVlan = varbinds[i + 8];
          if (vbVlan && vbVlan.type !== snmp.ObjectType.NoSuchObject && vbVlan.value) {
            realHardwareVlans[portNum] = getVlanLabelFromId(vbVlan.value);
          } else {
            realHardwareVlans[portNum] = "V1 (Default)";
          }
        }
      }
    });
  } catch (err) {
    console.error("[Excepción SNMP crítica]:", err.message);
  }
}

setTimeout(pollSwitchHardware, 1000);
setInterval(pollSwitchHardware, 2000);

function broadcastNetworkState(socketTarget) {
  let evaluatedDevices = [];
  let timestamp = new Date().toLocaleTimeString();
  let portsState = [];

  for (let i = 1; i <= 8; i++) {
    const hardwareStatus = realHardwarePortsState[i] || "Down";
    const currentVlan = realHardwareVlans[i] || "V1 (Default)";

    portsState.push({ 
      port: i, 
      name: `Puerto ${i}`, 
      status: hardwareStatus, 
      device: "Libre", 
      vlanName: currentVlan, 
      speed: hardwareStatus === "Up" ? "1 Gbps" : "-", 
      traffic: hardwareStatus === "Up" ? "Activo / Normal" : "Sin tráfico" 
    });
  }

  portsState.push({ port: 9, name: "SFP 1", status: realHardwarePortsState[9] || "Down", device: "Libre", vlanName: "N/A", speed: "-", traffic: "Sin tráfico" });
  portsState.push({ port: 10, name: "SFP 2", status: realHardwarePortsState[10] || "Down", device: "Libre", vlanName: "N/A", speed: "-", traffic: "Sin tráfico" });

  for (let ip of Object.keys(activeRegistry)) {
    let devInfo = activeRegistry[ip];
    let assignedPort = devInfo.port || 1;
    let isPortActive = realHardwarePortsState[assignedPort] === "Up";
    let currentVlan = realHardwareVlans[assignedPort] || "V10 (Audio Pri)";
    let style = vlanStyles[currentVlan] || { bg: "rgba(168, 85, 247, 0.2)", color: "#a855f7" };

    if (devInfo.linked) {
      evaluatedDevices.push({
        id: `dev-${ip.replace(/\./g, '-')}`,
        name: devInfo.name,
        type: devInfo.type,
        ip: ip,
        port: assignedPort,
        sensitivity: devInfo.sensitivity || "N/A",
        status: isPortActive ? "Online" : "Desconectado",
        isOnline: isPortActive,
        isClockMaster: (ip === currentClockMasterIp),
        danteLatencyConfig: devInfo.latencyConfig || "1.0 ms",
        vlanName: currentVlan,
        vlanBg: style.bg,
        vlanColor: style.color
      });

      let targetPort = portsState.find(p => p.port === assignedPort);
      if (targetPort) {
        targetPort.status = isPortActive ? "Up" : "Down";
        targetPort.device = devInfo.name;
        targetPort.vlanName = currentVlan;
      }
    }
  }

  socketTarget.emit('networkUpdate', {
    switchModel: activeSwitchModel,
    devices: evaluatedDevices,
    ports: portsState,
    timestamp: timestamp
  });
}

io.on('connection', (socket) => {
  console.log('[Socket] Cliente conectado.');
  broadcastNetworkState(socket);

  socket.on('changeSwitch', (model) => {
    activeSwitchModel = model;
    broadcastNetworkState(io);
  });

  socket.on('setClockMaster', (ip) => {
    currentClockMasterIp = ip;
    broadcastNetworkState(io);
  });

  socket.on('uploadDanteXml', (xmlContent) => {
    xml2js.parseString(xmlContent, (err, result) => {
      if (err) {
        console.error("[XML Error]: No se pudo parsear el XML", err);
        socket.emit('xmlParseResult', { success: false, message: "Error al leer el formato XML." });
        return;
      }

      try {
        const preset = result.preset;
        if (!preset || !preset.device) {
          throw new Error("Formato XML inválido.");
        }

        let newRegistry = {};
        let detectedClockMasterIp = currentClockMasterIp;
        let assignedPortCounter = 1;

        preset.device.forEach((dev) => {
          const devName = dev.name ? dev.name[0] : "Dispositivo Dante";
          const modelName = dev.model_name ? dev.model_name[0] : "AVIO Audio";
          
          let devIp = "192.168.1.50"; 
          if (dev.interface && dev.interface[0] && dev.interface[0].ipv4_address) {
            const addrObj = dev.interface[0].ipv4_address[0];
            if (addrObj.address && addrObj.address[0]) {
              devIp = addrObj.address[0];
            }
          }

          let targetPort = assignedPortCounter <= 8 ? assignedPortCounter : 8;
          if (activeRegistry[devIp] && activeRegistry[devIp].port) {
            targetPort = activeRegistry[devIp].port;
          } else {
            assignedPortCounter++;
          }

          let configuredLatencyStr = "1.0 ms";
          if (dev.unicast_latency && dev.unicast_latency[0]) {
            const latencyUsec = parseInt(dev.unicast_latency[0], 10);
            if (!isNaN(latencyUsec)) {
              configuredLatencyStr = (latencyUsec / 1000).toFixed(1) + " ms";
            }
          }

          let sensitivityStr = "Línea Estándar";
          const modelStrUpper = modelName.toUpperCase();

          if (modelStrUpper.includes("AES")) {
            sensitivityStr = "Digital AES/EBU";
          } else if (modelStrUpper.includes("USB")) {
            sensitivityStr = "USB Audio Class";
          } else if (modelStrUpper.includes("VIA") || modelStrUpper.includes("VIRTUAL")) {
            sensitivityStr = "CoreAudio / Virtual";
          } else {
            try {
              if (dev.codecParams && dev.codecParams[0] && dev.codecParams[0].codecValue) {
                const codecValues = dev.codecParams[0].codecValue;
                if (codecValues && codecValues[0] && codecValues[0].value && codecValues[0].value[0]) {
                  const rawVal = codecValues[0].value[0];
                  if (rawVal === "2") sensitivityStr = "+24 dBu";
                  else if (rawVal === "1") sensitivityStr = "+4 dBu / 0 dBV";
                  else if (rawVal === "3") sensitivityStr = "+4 dBu";
                  else sensitivityStr = `Nivel: ${rawVal}`;
                } else {
                  sensitivityStr = "+24 dBu / +4 dBu";
                }
              } else {
                sensitivityStr = modelStrUpper.includes("DAO") ? "+24 dBu (Output)" : "+4 dBu (Input)";
              }
            } catch (ex) {
              sensitivityStr = "+24 dBu / +4 dBu";
            }
          }

          let isMaster = false;
          if (dev.clock_priority && dev.clock_priority[0] && dev.clock_priority[0].preferred) {
            if (dev.clock_priority[0].preferred[0] === 'true') {
              isMaster = true;
              detectedClockMasterIp = devIp;
            }
          }

          if (isMaster) {
            detectedClockMasterIp = devIp;
          }

          newRegistry[devIp] = {
            name: devName,
            type: modelName,
            ip: devIp,
            port: targetPort,
            sensitivity: sensitivityStr,
            latencyConfig: configuredLatencyStr,
            linked: true
          };
        });

        activeRegistry = newRegistry;
        currentClockMasterIp = detectedClockMasterIp;

        socket.emit('xmlParseResult', { 
          success: true, 
          message: `¡Preset cargado! ${Object.keys(activeRegistry).length} dispositivos importados correctamente manteniendo puertos físicos.` 
        });

        broadcastNetworkState(io);

      } catch (parseEx) {
        console.error("[XML Parse Error]:", parseEx);
        socket.emit('xmlParseResult', { success: false, message: "Error al procesar la estructura del XML." });
      }
    });
  });

  const syncInterval = setInterval(() => {
    broadcastNetworkState(socket);
  }, 2000);

  socket.on('disconnect', () => clearInterval(syncInterval));
});

server.listen(3000, () => {
  console.log('Servidor Stage Scope operativo en http://localhost:3000');
});