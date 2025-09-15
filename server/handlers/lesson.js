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
            if (!context.roomId || !context.clientId) {
                return callback({ result: false, data: 'roomId and clientId are required'});
            }
            ({log_} = data);
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
            log_ = data['log'];
            if(!log_)
            {
                return callback({result:false, data:'log is required'});
            }
            console.log(JSON.stringify(log_));
            const ts = room.clients.get(context.clientId).join_ts;
            const perClientLog = room.clients_log.get(context.clientId);
            perClientLog.set(ts, { end_ts: Date.now(), log: log_ });

            room.clients_log_isComplete.set(context.clientId, true);
            
            let not_complete_list = [] 
            room.clients_log_isComplete.forEach((value, key) => {
                if(!value && key !== room.creator_client_id)
                {
                    console.log(`log_complete not complete ${key}`);
                    not_complete_list.push(key);
                }
            });
            
            
            if(not_complete_list.length  === 0)
            {
                console.log(`log_compelte all done`);
                const full_log = {};
                room.clients_log.forEach((clientLogMap, cid) => {
                    full_log[cid] = Object.fromEntries(clientLogMap);
                });
                const res = {
                    full_log, 
                    lesson_start : room.lesson.start_time, 
                    lesson_end: room.lesson.end_time
                };
                socket.to(context.roomId).emit('log_all_complete', res);
            }
            else
            {
                console.log(`log competle not all done`);
                console.log(JSON.stringify(not_complete_list));
            }
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