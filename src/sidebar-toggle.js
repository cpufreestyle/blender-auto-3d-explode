// 侧栏折叠（3D 视图要全宽的那一刻）。
//
// 工具面板 340px 宽，在拆解视图里占掉小半屏：想看清整机结构时，用户的第一反应
// 就是把它收起来。做法与主题/外观切换一致——初值读 localStorage("quest3-sidebar")
// （缺省 open），点击切换 .ui-overlay 的 collapsed（transform 滑出视口）、回写
// 存储、同步 aria-expanded 与浮动展开钮的显隐，并给收起的面板打 inert：否则 Tab
// 照样能钻进一块看不见的面板，键盘用户会被困在里面。
//
// 面板与两个按钮都按 id 自取（不依赖 main.js 传引用，接线只剩一行），任一缺失时
// 静默跳过并返回 null。返回 { toggle, isCollapsed } 给 H 快捷键用。
export function setupSidebarToggle() {
  const overlay = document.getElementById("ui-overlay");
  const collapseBtn = document.getElementById("sidebar-collapse");
  const expandBtn = document.getElementById("sidebar-expand");
  if (!overlay || !collapseBtn || !expandBtn) return null;

  let collapsed = localStorage.getItem("quest3-sidebar") === "collapsed";
  // inert 并非所有浏览器都有；不支持时退化成「只是看不见」，Tab 仍进得去
  const canInert = "inert" in overlay;

  const apply = () => {
    overlay.classList.toggle("collapsed", collapsed);
    if (canInert) overlay.inert = collapsed;
    expandBtn.classList.toggle("hidden", !collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    expandBtn.setAttribute("aria-expanded", String(!collapsed));
  };

  const toggle = () => {
    collapsed = !collapsed;
    localStorage.setItem("quest3-sidebar", collapsed ? "collapsed" : "open");
    apply();
    // 键盘用户：焦点跟着面板走，别留在已经 inert 的那个按钮上
    if (document.activeElement === collapseBtn && collapsed) expandBtn.focus();
    else if (document.activeElement === expandBtn && !collapsed) collapseBtn.focus();
    return collapsed;
  };

  collapseBtn.addEventListener("click", toggle);
  expandBtn.addEventListener("click", toggle);
  apply();
  return { toggle, isCollapsed: () => collapsed };
}
