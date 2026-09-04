/**
 * ============================================================
 * 类型化 API 层 - 关注（/api/friends）
 * ============================================================
 */

import api from './http';
import type { User } from '../types';

export interface RecommendUser {
  id: number;
  username: string;
  avatar: string | null;
}

export function listRecommended(): Promise<{ users: RecommendUser[] }> {
  return api.get('/friends/recommend').then(r => r.data);
}

export function searchUsers(q: string): Promise<{ users: User[] }> {
  return api.get('/friends/search', { params: { q } }).then(r => r.data);
}

export function followStatus(targetId: number): Promise<{ is_following: boolean }> {
  return api.get(`/friends/status/${targetId}`).then(r => r.data);
}

export function follow(targetId: number): Promise<{ is_following: boolean; followers_count: number }> {
  return api.post(`/friends/${targetId}`).then(r => r.data);
}

export function unfollow(targetId: number): Promise<{ is_following: boolean; followers_count: number }> {
  return api.delete(`/friends/${targetId}`).then(r => r.data);
}

export function listFollowers(targetId: number): Promise<{ users: User[] }> {
  return api.get(`/friends/followers/${targetId}`).then(r => r.data);
}

export function listFollowing(targetId: number): Promise<{ users: User[] }> {
  return api.get(`/friends/following/${targetId}`).then(r => r.data);
}

export function myFollowing(): Promise<{ friends: User[] }> {
  return api.get('/friends').then(r => r.data);
}
