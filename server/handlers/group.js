function group_handler(io, socket, rooms, context) {
    socket.on('set_group', (data, callback) => {
        try {
            const { groupId, video_id, audio_id } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.clientId);

            if (!room || !clientData) {
                return callback({ result: false, data: 'Not in a room' });
            }
            console.log(`groupId: ${groupId}, video_id: ${video_id}, audio_id: ${audio_id}`);
            // Validate IDs and set to "NULL" if invalid
            const final_video_id = clientData.producers.has(video_id) ? video_id : "NULL";
            const final_audio_id = clientData.producers.has(audio_id) ? audio_id : "NULL";

            // Case 1: Create a new group if groupId is 0 or not provided
            if (groupId == 0 || !groupId) {
                const newGroupId = room.nextGroupId++;
                const groupData = {
                    groupId: newGroupId,
                    video_id: final_video_id,
                    audio_id: final_audio_id,
                    clientId: context.clientId
                };

                room.groups.set(newGroupId, groupData);
                clientData.groups.set(newGroupId, groupData);

                console.log(`Group ${newGroupId} CREATED for client ${context.clientId}:`, groupData);
                socket.to(context.roomId).emit('update_group_one', { group_id: newGroupId, mode: 'create', data: groupData });
                callback({ result: true, data: groupData });
            }
            // Case 2: Edit an existing group
            else {
                const groupToEdit = room.groups.get(groupId);

                if (!groupToEdit) {
                    return callback({ result: false, data: `Group with ID ${groupId} not found.` });
                }
                if (groupToEdit.clientId !== context.clientId) {
                    return callback({ result: false, data: 'Not authorized to edit this group.' });
                }

                const updatedGroupData = {
                    ...groupToEdit,
                    video_id: final_video_id,
                    audio_id: final_audio_id
                };

                room.groups.set(groupId, updatedGroupData);
                clientData.groups.set(groupId, updatedGroupData); // Also update the client's own map

                console.log(`Group ${groupId} EDITED by client ${context.clientId}:`, updatedGroupData);
                socket.to(context.roomId).emit('update_group_one', { group_id: groupId, mode: 'edit', data: updatedGroupData });
                callback({ result: true, data: updatedGroupData });
            }
        } catch (err) {
            console.error(`[ERROR] in 'set_group' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
    socket.on('get_groups', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.clientId);
            data = { groups: Array.from(room.groups.entries()) };
            callback({ result: true, data });
        } catch (err) {
            console.error(`[ERROR] in 'get_groups' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    })
    socket.on('del_group', (data, callback) => {
        try {
            const { groupId } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.clientId);

            if (!room || !clientData) {
                return callback({ result: false, data: 'Not in a room' });
            }

            const groupToDelete = room.groups.get(groupId);

            if (!groupToDelete) {
                return callback({ result: false, data: `Group with ID ${groupId} not found.` });
            }

            if (groupToDelete.clientId !== context.clientId) {
                return callback({ result: false, data: 'Not authorized to delete this group.' });
            }

            // Delete the group from the room and the client's list
            room.groups.delete(groupId);
            clientData.groups.delete(groupId);

            console.log(`Group ${groupId} DELETED by client ${context.clientId}`);

            // Notify everyone in the room
            socket.to(context.roomId).emit('update_group_one', { group_id: groupId, mode: 'delete', data: groupToDelete });

            callback({ result: true, data: { deletedGroupId: groupId } });
        } catch (err) {
            console.error(`[ERROR] in 'del_group' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
}

export default group_handler;