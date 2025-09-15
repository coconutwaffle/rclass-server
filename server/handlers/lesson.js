function make_dummy_log(start_ts, end_ts)
{
    return {
            "per_block": [
            {
                "closed_frames": 0,
                "end_ms": 0,
                "label": "NO_CAMERA",
                "noface_frames": 0,
                "open_frames": 0,
                "open_ratio": 0,
                "start_ms": 0,
                "total_frames": 0
            }
            ],
            "summary": {
            "blocks": 0,
            "frame_open_ratio": 0,
            "no_camera_blocks": 0,
            "noface_blocks": 0,
            "notopen_blocks": 0,
            "open_blocks": 0,
            "total_closed": 0,
            "total_frames": 0,
            "total_noface": 0,
            "total_open": 0
            }
    }
}
function check_log_complete(io, socket, room, context)
{
    try {
        let not_complete_list = [] 
        room.clients_log_isComplete.forEach((value, key) => {
            if(!value && key !== room.creator_client_id)
            {
                console.log(`log_complete not complete ${key}`);
                if(room.clients.has(key))
                {
                    not_complete_list.push(key);
                } else
                {
                    room.clients_log_isComplete.set(key, true);
                    if(room.clients_log.has(key))
                    {
                        const log_ = make_dummy_log();
                        const ts = room.clients.get(key).join_ts;
                        room.clients_log.get(key).set(ts, {end_ts: Date.now(), log:log_});
                    }
                    console.log(`[check_log_complete] client ${key} disconnected, force-completed log`);
                }
            }
        });

        if(not_complete_list.length  === 0)
        {
            console.log(`log_compelte all done`);
            const full_log = {};
            room.clients_log.forEach((clientLogMap, cid) => {
                if(cid !== room.creator_client_id)
                    full_log[cid] = Object.fromEntries(clientLogMap);
            });
            const res = {
                full_log, 
                lesson_start : room.lesson.start_time, 
                lesson_end: room.lesson.end_time
            };
            console.log("emit all " + JSON.stringify(res, null, 2));
            io.to(context.roomId).emit('log_all_complete', res);
            console.log(`emit done roomid: ${context.roomId}`);
        }
        else
        {
            console.log(`log competle not all done`);
            console.log(JSON.stringify(not_complete_list));
        }
    } catch(e){
        console.error(`[ERROR] in 'check_log_complete' handler:`, e);
        if (e instanceof Error) {
            console.error(e.stack);
        }
    }
}

module.exports = (io, socket, rooms, context) => {
    socket.on('lesson_start', (data, callback) => {
        try {
            if(!context.logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== context.logon_id)
            {
                callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state !== 'Not started')
            {
                return callback({result:false, data:'Already started'})
            }
            room.lesson.state = 'Started';
            room.lesson.start_time = Date.now();
            console.log(`lesson_start room: ${context.roomId}`)
            const res = {start_ts:room.lesson.start_time};
            socket.to(context.roomId).emit('lesson_started',  res)
            callback({result:true, data: res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_start' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_end', (data, callback) => {
        try {
            if(!context.logon_id)
            {
                return callback({result: false, data:'log on required'});
            }
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            if(room.creator !== context.logon_id)
            {
                return callback({result:false, data:'Not creator'});
            }
            if(room.lesson.state === 'Not started')
            {
                return callback({result:false, data:'Not started'});
            }
            if(room.lesson.state === 'Ended')
            {
                return callback({result:false, data:'Already ended'});
            }
            room.lesson.state = 'Ended';
            room.lesson.end_time = Date.now();
            console.log(`lesson_end room: ${context.roomId}`);
            res = {start_ts:room.lesson.start_time, end_ts: room.lesson.end_time};
            socket.to(context.roomId).emit('lesson_ended', res);
            check_log_complete(io, socket, room, context);
            callback({result:true, data:res});
        } catch (e) {
            console.error(`[ERROR] in 'lesson_end' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('lesson_state', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            callback({result:true, data:{state: room.lesson.state}});
        } catch(e) {
            console.error(`[ERROR] in 'lesson_state' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
    socket.on('log_backup', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });
            const log_ = data['log'];
            if(!log_)
            {
                callback({result:false, data:'log is required'});
            }
            const ts = room.clients.get(context.clientId).join_ts;
            room.clients_log.get(context.clientId).set(ts, {end_ts: Date.now(), log:log_});
            callback({result:true, data:{join_ts:ts}});
            
        } catch(e) {
            console.error(`[ERROR] in 'log_backup' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    });
    socket.on('log_complete', (data, callback) => {
        try {
            if (!context.roomId || !context.clientId) {
                return callback({ result: false, data: 'roomId and clientId are required' });
            }
            let room = rooms[context.roomId];
            const log_ = data['log'];
            if(!log_)
            {
                return callback({result:false, data:'log is required'});
            }
            console.log(JSON.stringify(log_));
            const ts = room.clients.get(context.clientId).join_ts;
            const perClientLog = room.clients_log.get(context.clientId);
            perClientLog.set(ts, { end_ts: Date.now(), log: log_ });

            room.clients_log_isComplete.set(context.clientId, true);
            check_log_complete(io, socket, room, context);
            kkk = {full_log: Object.fromEntries(perClientLog) };
            console.log(`ack log_complete to ${context.clientId}`); 
            callback({result: true, data: kkk});
            
        } catch(e) {
            console.error("log_complete error:", e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
}