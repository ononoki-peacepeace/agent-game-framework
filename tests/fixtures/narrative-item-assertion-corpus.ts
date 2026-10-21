// Fixed N4.3/N4.4 extension: current assertions versus hypothetical/typed speech.
// Expectations are frozen before running the unchanged implementation.
export const itemAssertionCorpus = [
  {id:'if-hypothesis',condition:'damaged',legal:true,text:'如果纸片完好，你会更安心。'},
  {id:'suppose-hypothesis',condition:'destroyed',legal:true,text:'假如纸片仍然完好，你会更安心。'},
  {id:'provided-hypothesis',condition:'damaged',legal:true,text:'要是纸片已经完好，你会更安心。'},
  {id:'if-independent-tail',condition:'damaged',legal:false,text:'如果纸片完好，你会更安心。纸片已经完好。'},
  {id:'suppose-independent-tail',condition:'destroyed',legal:false,text:'假如纸片仍然完好，你会更安心，纸片已经完好。'},
  {id:'provided-independent-tail',condition:'damaged',legal:false,text:'要是纸片已经完好，你会更安心；纸片现在完好。'},
  {id:'passive-destruction-supported',condition:'destroyed',legal:true,text:'纸片已经被损毁。'},
  {id:'passive-destruction-invented',condition:'intact',legal:false,text:'纸片已经被损毁。'},
  {id:'passive-damage-supported',condition:'damaged',legal:true,text:'纸片已经被损坏。'},
  {id:'passive-damage-invented',condition:'intact',legal:false,text:'纸片已经被损坏。'},
  {id:'passive-denial-supported',condition:'intact',legal:true,text:'纸片并未被损毁。'},
  {id:'passive-denial-contradicted',condition:'destroyed',legal:false,text:'纸片并未被损毁。'},
  {id:'passive-typed-retelling',condition:'intact',legal:true,text:'林舟：“纸片已经被损毁”。纸片仍然完好。',speech:true},
  {id:'passive-retelling-tail',condition:'intact',legal:false,text:'林舟：“纸片已经被损毁”。纸片已经被损毁。',speech:true},
] as const;
