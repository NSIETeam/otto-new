/** One researched company set, with explicitly simulated supply/need fields for interaction only. */
import { demoMap, type StarMapData } from './model.js';
const scenarios: Record<string, { products: string[]; needs: string[] }> = {
  '002': { products: ['工业视觉检测'], needs: ['自动化设备', '生产管理软件'] },
  '011': { products: ['自动化设备'], needs: ['工业视觉检测', '官网建设'] },
  '018': { products: ['生产管理软件', '官网建设'], needs: ['招聘培训'] },
  '010': { products: ['招聘培训'], needs: ['官网建设'] },
  '003': { products: ['数据存储服务'], needs: ['生产管理软件', '招聘培训'] },
  '019': {
    products: ['医疗设备装配'],
    needs: [
      '工业视觉检测',
      '自动化设备',
      '数据存储服务',
      '官网建设',
      '招聘培训',
    ],
  },
  '006': { products: ['教学设备'], needs: ['官网建设'] },
  '012': { products: ['商务差旅'], needs: [] },
  '004': { products: ['射频测试'], needs: ['数据存储服务'] },
  '005': { products: ['电子系统集成'], needs: ['射频测试', '官网建设'] },
  '007': { products: ['通信设备'], needs: ['电子系统集成'] },
  '008': { products: ['能源监测'], needs: ['数据存储服务', '通信设备'] },
  '009': { products: ['分析仪器'], needs: ['自动化设备'] },
  '016': { products: ['电子元件'], needs: ['射频测试'] },
  '017': { products: ['检验检测服务'], needs: ['分析仪器'] },
  '020': {
    products: ['医疗影像设备'],
    needs: ['医疗设备装配', '检验检测服务'],
  },
  '021': { products: ['生物检测设备'], needs: ['检验检测服务', '招聘培训'] },
};
export const supplyDemo: StarMapData = {
  ...demoMap,
  nodes: demoMap.nodes.map((node) => {
    const scenario = scenarios[node.organizationId.split('-').at(-1)!];
    if (!scenario)
      throw new Error(`Missing demo scenario: ${node.organizationId}`);
    return {
      ...node,
      demoProductsServices: [...scenario.products],
      demoCooperationNeeds: [...scenario.needs],
    };
  }),
};
