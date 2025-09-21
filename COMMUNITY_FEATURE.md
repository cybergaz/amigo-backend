# Community Feature Documentation

## Overview

The Community feature allows super admins to create communities and manage time-restricted groups within those communities. This feature extends the existing chat system to support structured community-based messaging with temporal access controls.

## Key Features

### 1. Community Management
- **Super Admin Control**: Only users with "admin" role can create communities
- **Community CRUD**: Create, read, update, and delete communities
- **Member Management**: Add/remove members, manage roles
- **Metadata Support**: Flexible metadata storage for community settings

### 2. Time-Restricted Groups
- **Active Time Slots**: Groups can be configured with specific time windows (e.g., 10:00-13:00, 15:00-18:00)
- **Timezone Support**: Each group can have its own timezone setting
- **Day-of-Week Control**: Specify which days the group is active (0=Sunday, 6=Saturday)
- **Multiple Time Slots**: Support for multiple active periods per day

### 3. Integration with Existing Chat System
- **Seamless Integration**: Community groups appear in regular chat lists
- **Message History**: Full conversation history support
- **Message Operations**: All existing message operations (pin, star, reply, forward, delete) work
- **WebSocket Support**: Real-time messaging support

## Database Schema

### New Tables

#### `communities`
```sql
- id: bigint (Primary Key)
- name: varchar(255) (Community name)
- description: varchar(1000) (Optional description)
- super_admin_id: bigint (References users.id)
- metadata: jsonb (Additional settings)
- created_at: timestamp
- updated_at: timestamp
- deleted: boolean (Soft delete)
```

#### `community_members`
```sql
- id: bigint (Primary Key)
- community_id: bigint (References communities.id)
- user_id: bigint (References users.id)
- role: varchar (member, admin)
- joined_at: timestamp
- deleted: boolean (Soft delete)
```

### Updated Tables

#### `conversations`
- Added support for `type: "community_group"`
- `metadata` field now includes time restrictions for community groups:
  ```json
  {
    "community_id": 123456789,
    "active_time_slots": [
      {
        "start_time": "10:00",
        "end_time": "13:00"
      },
      {
        "start_time": "15:00",
        "end_time": "18:00"
      }
    ],
    "timezone": "UTC",
    "active_days": [1, 2, 3, 4, 5]
  }
  ```

## API Endpoints

### Community Management

#### Create Community
```http
POST /api/community/create
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "Tech Community",
  "description": "A community for tech enthusiasts",
  "metadata": {}
}
```

#### Get Communities
```http
GET /api/community/list
Authorization: Bearer {token}
```

#### Get Community Details
```http
GET /api/community/{community_id}
Authorization: Bearer {token}
```

#### Update Community
```http
PUT /api/community/{community_id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "Updated Community Name",
  "description": "Updated description"
}
```

#### Delete Community
```http
DELETE /api/community/{community_id}
Authorization: Bearer {token}
```

### Member Management

#### Add Members
```http
POST /api/community/{community_id}/members/add
Authorization: Bearer {token}
Content-Type: application/json

{
  "user_ids": [123, 456, 789],
  "role": "member"
}
```

#### Remove Members
```http
POST /api/community/{community_id}/members/remove
Authorization: Bearer {token}
Content-Type: application/json

{
  "user_ids": [123, 456]
}
```

#### Get Members
```http
GET /api/community/{community_id}/members
Authorization: Bearer {token}
```

### Community Group Management

#### Create Community Group
```http
POST /api/community/{community_id}/groups/create
Authorization: Bearer {token}
Content-Type: application/json

{
  "title": "Morning Standup",
  "active_time_slots": [
    {
      "start_time": "10:00",
      "end_time": "13:00"
    }
  ],
  "timezone": "UTC",
  "active_days": [1, 2, 3, 4, 5]
}
```

#### Update Community Group
```http
PUT /api/community/groups/{conversation_id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "title": "Updated Group Name",
  "active_time_slots": [
    {
      "start_time": "09:00",
      "end_time": "12:00"
    }
  ]
}
```

#### Get Community Groups
```http
GET /api/community/{community_id}/groups
Authorization: Bearer {token}
```

#### Delete Community Group
```http
DELETE /api/community/groups/{conversation_id}
Authorization: Bearer {token}
```

## Time Restriction Examples

### Example 1: Business Hours Group
```json
{
  "title": "Work Discussion",
  "active_time_slots": [
    {
      "start_time": "09:00",
      "end_time": "17:00"
    }
  ],
  "timezone": "America/New_York",
  "active_days": [1, 2, 3, 4, 5]
}
```

### Example 2: Multiple Break Times
```json
{
  "title": "Break Time Chat",
  "active_time_slots": [
    {
      "start_time": "10:30",
      "end_time": "11:00"
    },
    {
      "start_time": "15:30",
      "end_time": "16:00"
    }
  ],
  "timezone": "UTC",
  "active_days": [1, 2, 3, 4, 5]
}
```

### Example 3: Weekend Only
```json
{
  "title": "Weekend Casual",
  "active_time_slots": [
    {
      "start_time": "10:00",
      "end_time": "22:00"
    }
  ],
  "timezone": "UTC",
  "active_days": [0, 6]
}
```

## Permission System

### Roles

#### Super Admin (User with role="admin")
- Create communities
- Delete communities
- Update community settings
- Manage all community groups

#### Community Admin
- Add/remove community members
- Create community groups
- Update community groups
- Delete community groups

#### Community Member
- View community details
- Participate in community groups
- View community groups list

## Frontend Integration Notes

1. **Time Validation**: Frontend should validate time restrictions before allowing message sending
2. **UI Indicators**: Show active/inactive status based on current time and group settings
3. **Timezone Handling**: Convert group times to user's local timezone for display
4. **Group Visibility**: Community groups appear in regular chat list with special indicators

## Implementation Details

### Time Slot Validation
- Time format: "HH:MM" (24-hour format)
- Start time must be before end time
- Multiple time slots supported per group
- Days: 0=Sunday, 1=Monday, ..., 6=Saturday

### Database Considerations
- Soft delete implemented for communities and community groups
- Foreign key constraints ensure data integrity
- JSONB metadata for flexible group settings
- Indexed queries for performance

### Error Handling
- Proper permission checks at service level
- Validation for time slot formats
- Graceful handling of missing communities/groups
- Comprehensive error messages

## Testing

Use the provided `community.test.http` file for comprehensive API testing. The test file includes:
- Community CRUD operations
- Member management
- Group creation with various time configurations
- Integration with existing chat features

## Migration

To apply the new database schema:
1. Run `bunx drizzle-kit generate` to create migration files
2. Run `bunx drizzle-kit migrate` to apply migrations
3. Ensure proper user roles are set for super admins

## Future Enhancements

Potential future improvements:
1. **Recurring Schedules**: Support for weekly/monthly recurring patterns
2. **Holiday Exceptions**: Skip active times on specified holidays
3. **Auto-Archive**: Automatically archive old community groups
4. **Member Limits**: Set maximum member limits per community
5. **Approval System**: Require approval for joining communities
6. **Analytics**: Track community engagement and usage patterns
