/**
 * ============================================================
 * 中国象棋引擎：基础类型（@k/shared/chess）
 * ============================================================
 * 坐标系约定（引擎与 UI 共用，全库唯一事实来源）：
 * - f（file/纵线）：0-8，红方视角从左到右；
 * - r（rank/横线）：0-9，0 = 红方底线、9 = 黑方底线；
 * - 交点索引 = r * 9 + f；
 * - 红方"前进"为 r+1，黑方为 r-1；过河：红 r>=5、黑 r<=4。
 * 棋子单字符：红方大写（R车 N马 B相 A仕 K帅 C炮 P兵）、黑方小写。
 */

export type ChessPiece = 'R' | 'N' | 'B' | 'A' | 'K' | 'C' | 'P' | 'r' | 'n' | 'b' | 'a' | 'k' | 'c' | 'p';

export type ChessSide = 'red' | 'black';

/** 棋盘交点 */
export interface ChessSquare {
  f: number;
  r: number;
}

/** 一着棋（captured=null 表示吃空） */
export interface ChessMove {
  from: ChessSquare;
  to: ChessSquare;
  piece: ChessPiece;
  captured: ChessPiece | null;
}

/** 长度 90 的棋盘（index = r*9+f，空点为 null） */
export type ChessBoard = (ChessPiece | null)[];

export type ChessGameStatus = 'playing' | 'red-win' | 'black-win' | 'draw';

/** 引擎级终局原因（认输/断线/超时等对局层原因由服务端协议补充，见 protocol.ts） */
export type ChessEndReason = 'checkmate' | 'stalemate' | 'insufficient' | 'repetition' | 'perpetual';

/**
 * 引擎对局状态。positionKeys 为"棋盘+行棋方"串的历史（含初始局面），
 * 供三次重复局面与长将判负使用；checkFlags 与 moves 一一对应，
 * 记录每着之后轮到方是否被将（长将判负的判定依据）。
 */
export interface ChessGameState {
  board: ChessBoard;
  turn: ChessSide;
  status: ChessGameStatus;
  statusReason: ChessEndReason | null;
  moves: ChessMove[];
  checkFlags: boolean[];
  positionKeys: string[];
}
