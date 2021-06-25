const { ADS_STATE } = require("ads-client/src/ads-client-ads")

module.exports = function (RED) {

  function AdsClientPlc(config) {
    RED.nodes.createNode(this, config)

    let node = this;

    //Getting the ads-client instance
    node.connection     = RED.nodes.getNode(config.connection)

    //Properties
    node.name           = config.name
    node.targetAdsPort  = config.port
    node.events         = config.events && node.connection //Disable events when no connection is configured


    //Add event listener
    function connectCallback(){
        const client = node.connection.getClient();
        client.on('plcRuntimeStateChange',plcStateChangeCallback,{"once":true});
        client.on('systemManagerStateChange',systemStateChangeCallback,{"once":true});
        client.on('disconnect',disconnectCallback,{"once":true})
        systemStateChangeCallback();
    }
    if (node.events) {
        node.connection.getClient().on('connect',connectCallback);
    }


    //On node close
    node.on('close', function() {
        //Remove event listener
        if (node.events) {
            node.connection.getClient().removeListener('plcRuntimeStateChange',plcStateChangeCallback);
            node.connection.getClient().removeListener('systemManagerStateChange',systemStateChangeCallback);
            node.connection.getClient().removeListener('connect',connectCallback);
            node.connection.getClient().removeListener('disconnect',disconnectCallback);
        }
    });

    //When input is toggled, try to read state
    node.on('input', async (msg, send, done) => {

      if (!node.connection) {
        node.status({ fill: 'red', shape: 'ring', text: `Error` })
        var err = new Error(`No connection configured`);
        (done)? done(err):  node.error(err, msg);
        return;
      }

      if (!node.connection.isConnected()) {
        //Try to connect
        try {
          await node.connection.connect()

        } catch (err) {
          //Failed to connect, we can't work..
          node.status({ fill: 'red', shape: 'ring', text: `Disconnected` });
          (done)? done(err):  node.error(err, msg);
          return;
        }
      }



      //Finally,read system/plc state
      try {

        //read system status
        let SysStatus = await node.connection.getClient().readSystemManagerState();

        //Control systemManager
        if(msg && msg.payload && typeof(msg.payload.systemManager) !== "undefined"){
          if(msg.payload.systemManager<0){ //-1
              await node.connection.getClient().restartSystemManager(); 
          }else if (msg.payload.systemManager==false && SysStatus.adsState == ADS_STATE.Run){ //0, false
              await node.connection.getClient().setSystemManagerToConfig(); 
          }else if (msg.payload.systemManager==true && SysStatus.adsState == ADS_STATE.Config){ //1, true
              await node.connection.getClient().setSystemManagerToRun(); 
          }
          SysStatus = await node.connection.getClient().readSystemManagerState();
        }

        let inRun = SysStatus.adsState == ADS_STATE.Run;

        //read plc status
        let PlcStatus = inRun? await node.connection.getClient().readPlcRuntimeState() : null;

        //Control plc
        if(msg && msg.payload && typeof(msg.payload.plc) !== "undefined" && inRun){
          if(msg.payload.plc<0){ //-1
              await node.connection.getClient().restartPlc(); 
          }else if (msg.payload.plc==false && PlcStatus.adsState == ADS_STATE.Run){ //0, false
              await node.connection.getClient().stopPlc(); 
          }else if (msg.payload.plc==true && PlcStatus.adsState == ADS_STATE.Stop){ //1, true
              await node.connection.getClient().startPlc(); 
          }
          PlcStatus = await node.connection.getClient().readPlcRuntimeState();
        }

        
        //Got status - display in status
        setStatus(inRun? PlcStatus : SysStatus,inRun);

        //Send status
        send({
          ...msg,
          payload: buildPayload(SysStatus,PlcStatus),
        })

        if (done) {
          done()
        }

      } catch (err) {

        node.status({ fill: 'red', shape: 'ring', text: `Error` })
        node.connection.formatError(err,msg);
        (done)? done(err):  node.error(err, msg);
        return;
      }

    })

    ///----------Callbacks------------
    //Callback on disconnect
    function disconnectCallback(){
      node.status({ fill: 'red', shape: 'ring', text: `Disconnected` });
      node.send({
        payload: "disconnected",
      });
    }

    //Callback on plcStateChange
    function plcStateChangeCallback(state){
      setStatus(state,true);
      node.send({
        payload: buildPayload(null,state),
      });
    }

    //Callback on systemStateChange
    function systemStateChangeCallback(state){
      state = node.connection.getClient().metaData.systemManagerState;  //Overwrite with full state object
      if(state.adsState == ADS_STATE.Run){
          node.emit('input',{}); //Read plc state
      }else{
          setStatus(state);
          node.send({
            payload: buildPayload(state,null),
          });
      }
    }

     ///----------Utilitie functions------------

    //Convert sysState, plcState to payload object
    function buildPayload(sysState, plcState){
        if (!sysState){
            sysState = node.connection.getClient().metaData.systemManagerState;
        }
        if (!plcState){
            plcState = { adsState: 0, adsStateStr: 'Invalid', deviceState: 0 };
        }

        return {"SysManager": sysState, "Plc": plcState}
    }

 
    //Convert state to node status
    function setStatus(state,plc){
      var pre = plc? "Plc: ": "";

      switch(state.adsState){
        case ADS_STATE.Invalid:
        case ADS_STATE.Stop:
        case ADS_STATE.PowerFailure:
        case ADS_STATE.Error:
        case ADS_STATE.Exception:
          node.status({ fill: 'red', shape: 'dot', text: pre + state.adsStateStr });
          break;

        case ADS_STATE.Idle:
        case ADS_STATE.Reset:
        case ADS_STATE.Incompatible:
          node.status({ fill: 'grey', shape: 'dot', text: pre + state.adsStateStr });
          break;

        case ADS_STATE.Initialize:
        case ADS_STATE.Config:
        case ADS_STATE.Reconfig:
        
          node.status({ fill: 'blue', shape: 'dot', text: pre + state.adsStateStr });
          break;

        case ADS_STATE.Run:
          node.status({ fill: 'green', shape: 'dot', text: pre + state.adsStateStr });
          break;

        case ADS_STATE.Start:
        case ADS_STATE.SaveConfig:
        case ADS_STATE.LoadConfig:
        case ADS_STATE.PowerGood:
        case ADS_STATE.Shutdown:
        case ADS_STATE.Susped:
        case ADS_STATE.Resume:
        case ADS_STATE.Stopping:
          node.status({ fill: 'yellow', shape: 'dot', text: pre + state.adsStateStr });
          break;

        default:
          node.status({ fill: 'red', shape: 'dot', text: pre + "Unknown state" });
          break;
      }
    }

  }

  


  RED.nodes.registerType('ads-client-plc', AdsClientPlc)
}
