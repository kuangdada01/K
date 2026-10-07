/**
 * ============================================================
 * 备案信息 (IcpFooter)
 * ============================================================
 * 首页底部备案链接（从 HomePage 抽出）
 * 注: Web 端 APP 下载按钮已暂时移除（需求暂不需要）
 */

import styles from './IcpFooter.module.css';

export default function IcpFooter() {
  return (
    <>
      <div
        className={styles.icp}
        onClick={() => window.open('https://beian.miit.gov.cn', '_blank')}
        title="工业和信息化部ICP/IP地址/域名信息备案管理系统"
      >
        湘ICP备2026022321号
      </div>
      <a
        className={styles.icpItem}
        target="_blank"
        href="http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=43042602000239"
        title="湖南省公安厅网络安全保卫总队"
      >
        <img src="/icp-icon.png" className={styles.policeIcon} alt="公安备案" />
        <span>湘公网安备43042602000239号</span>
      </a>
    </>
  );
}
