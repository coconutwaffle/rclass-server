const { Pool } = require('pg');
const config = require('../config');
const rooms_reserved = new Map();

const pool = new Pool({
  host: config.db_host,
  port: config.db_port,
  user: config.db_user,
  password: config.db_pass,
  database: config.db_name,
});

export function isRoomReserved(roomId)
{
    return rooms_reserved.has(roomId);
}

//다음 가장 빠른 수업 시작시간을 return.
//단, 수업 시작이 너무 멀 경우. throw
//설정된 수업 시간이 없을 경우 null
export function ReservedRoomInfo(roomId)
{
    let room_info = null
    if(isRoomReserved(roomId))
    {
        room_info = {
        creator: null,
        lesson_start: null, 
        lesson_end: null,
        }
    } else {
        throw new Error("Room Not exist");
    }
    return room_info;
}
function checkID(id, pwd){
    if(id === pwd)
        return true;
    else return false;
}
export function isLoggedIn(context)
{
    if(context.logon_id)
    {
        return true;
    } else
    {
        return false
    }
}
export function LogIn(id, pwd, context)
{
    if(checkID(id, pwd))
    {
        context.logon_id = id;
        return true;
    } else return false;
}
export function ReserveRoom(roomId, lesson_start, lesson_end, context)
{
    if(isLoggedIn(context))
    {
        rooms_reserved.set(roomId, {'creator': getLogOnId(context), lesson_start, lesson_end});
    }
}

export function getLogOnId(context)
{
    if(isLoggedIn(context))
    {
        return context.logon_id;
    }
    throw new Error("User is not logged in");
}
export async function archiveRoomToDB(room)
{

}
export async function loadRoomDB()
{

}
export function get_all_students(roomId)
{
    //TODO DB
    return [
        'qml-user',
        'asdf'
    ]
}
export function room_handler(io, socket, rooms, context){
    socket.on('create_room', async (data, callback) => {
        try {
            //TODO DB
            if(!isLoggedIn(context))
            {
                return callback({result: false, data:'log on required'});
            }
            roomId_ = data['roomId']
            if(!roomId_)
            {
                return callback({result: false, data:'roomId is required'});
            }
            if(rooms.hasOwnProperty(roomId_) || isRoomReserved(roomId_))
            {
                return callback({result: false, data:"room already exists"});
            }
            lesson_start = data['lesson_start'];
            lesson_end = data['lesson_end'];
            ReserveRoom(roomId_, lesson_start, lesson_end, context)
            console.log(`[create room] room reserved ${roomId_}`)
            callback({ result: true, data: { rtpCapabilities: router.rtpCapabilities } });
            
        } catch(e)
        {
            console.error(`[ERROR] in 'create_room' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })

    socket.on('delete_room', async (data, callback) => {
        try {
            //TODO DB
            if(!isLoggedIn(context))
            {
                return callback({result: false, data:'log on required'});
            }
            roomId_ = data['roomId']
            if(!roomId_)
            {
                return callback({result: false, data:'roomId is required'});
            }
            if(rooms.hasOwnProperty(roomId_) || isRoomReserved(roomId_))
            {
                return callback({result: false, data:"room already exists"});
            }
        } catch(e)
        {
            console.error(`[ERROR] in 'delete_room' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })

    socket.on('edit_room', async (data, callback) => {
        try {
            if(!isLoggedIn(context))
            {
                return callback({result: false, data:'log on required'});
            }
            roomId_ = data['roomId']
            if(!roomId_)
            {
                return callback({result: false, data:'roomId is required'});
            }
            if(!isRoomReserved(roomId_))
            {
                return callback({result: false, data:"Room Not exists"});
            }
            lesson_start = data['lesson_start'];
            lesson_end = data['lesson_end'];
            ReserveRoom(roomId_, lesson_start, lesson_end, context)
            console.log(`[edit room] room reserved ${roomId_}`)
            callback({ result: true, data: { rtpCapabilities: router.rtpCapabilities } });
            
        } catch(e)
        {
            console.error(`[ERROR] in 'create_room' handler:`, e);
            if (e instanceof Error) {
                console.error(e.stack);
            }
            callback({ result: false, data: e.message });
        }
    })
}