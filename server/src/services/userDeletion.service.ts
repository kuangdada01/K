/**
 * ============================================================
 * 用户删除服务（services/userDeletion.service）
 * ============================================================
 * 自 routes/admin.ts 的 DELETE /api/admin/users/:id 拆出，行为不变。
 *
 * 编排删号流程：删库前收集全部磁盘文件引用（postMedia / privateImageNames /
 * messageImageNames）→ deleteUser（外键级联删库）→ 删磁盘文件。
 * 顺序保证：中途失败最多留下孤儿文件，不会产生指向已删文件的死链。
 * 前置校验（不能删除自己的账号 / 用户不存在 / 不能删除管理员账号）仍在路由层。
 */

import path from 'path';
import { safeDeleteFile, deletePostMediaFiles } from '../lib/file';
import * as adminRepo from '../repositories/admin.repo';

/**
 * 删除用户及其磁盘文件
 *
 * @param user - 前置校验通过后的用户行（含 email 用于清理验证码记录、avatar 用于删头像）
 */
export function deleteUser(user: { id: number; email: string; avatar: string | null }): void {
  const userId = user.id;

  // 删库前收集全部磁盘文件引用（级联删除后行已不在，无从查起）
  const postMedia = adminRepo.listUserPostMedia(userId);
  const privateImageNames = adminRepo.listUserPrivateImageNames(userId);
  const messageImageNames = adminRepo.listUserMessageImageNames(userId);

  adminRepo.deleteUser(userId, user.email);

  // 头像
  if (user.avatar) {
    safeDeleteFile(user.avatar, 'uploads/avatars');
  }
  // 帖子媒体（图片/视频/封面）
  for (const media of postMedia) {
    deletePostMediaFiles(media);
  }
  // 私密图片与私信图片（uploads_private，DB 只存文件名）
  for (const name of privateImageNames) {
    safeDeleteFile(`/uploads_private/${path.basename(name)}`, 'uploads_private');
  }
  for (const name of messageImageNames) {
    safeDeleteFile(`/uploads_private/${path.basename(name)}`, 'uploads_private');
  }
}
