// The user's documented API fields, with synthetic filenames and credentials.
export const IMAGE_V3_APP_ID = '2079381758411587586';
export const IMAGE_V3_BODY = {
  nodeInfoList: [
    { nodeId: '181', fieldName: 'image', fieldValue: 'fixture-reference-1.png', description: 'Refer to Figure 1 (optional)' },
    { nodeId: '182', fieldName: 'image', fieldValue: 'fixture-reference-2.png', description: 'Refer to Figure 2 (optional)' },
    { nodeId: '183', fieldName: 'image', fieldValue: 'fixture-reference-3.png', description: 'Refer to Figure 3 (optional)' },
    { nodeId: '189', fieldName: 'value', fieldValue: '2048', description: 'Resolution' },
    { nodeId: '191', fieldName: 'value', fieldValue: '1', description: 'Quantity/Piece' },
    { nodeId: '195', fieldName: 'value', fieldValue: 'false', description: 'Other proportions (Text-to-image must be enabled)' },
    { nodeId: '194', fieldName: 'aspect_ratio', fieldData: JSON.stringify([['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'], { default: '1:1' }]), fieldValue: '3:4', description: 'Scale (Effective when the switch above is turned on)' },
    { nodeId: '107', fieldName: 'text', fieldValue: '图1女人和图2男人坐在图3沙发上。', description: 'Prompt' },
    { nodeId: '186', fieldName: 'value', fieldValue: 'false', description: 'Grayscale output (default Zip)' },
  ],
  instanceType: 'default',
  usePersonalQueue: 'false',
};
export const IMAGE_V3_CURL = `curl --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/${IMAGE_V3_APP_ID}' --header 'Authorization: Bearer QA_NOT_A_REAL_KEY' --header 'Content-Type: application/json' --data '${JSON.stringify(IMAGE_V3_BODY)}'`;
